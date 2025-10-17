const express = require('express');
const axios = require('axios');
const { Octokit } = require('@octokit/rest');
require('dotenv').config();

const app = express();
app.use(express.json());

// Load environment variables
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY; // Changed to Groq
const EXPECTED_SECRET = process.env.SECRET_KEY;
const EVALUATION_URL = process.env.EVALUATION_URL;

// Initialize APIs
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Server is running with Groq!' });
});

// Main API endpoint
app.post('/api-endpoint', async (req, res) => {
  console.log('Received request:', JSON.stringify(req.body, null, 2));
  
  try {
    const { email, task, round, nonce, secret, brief, attachments } = req.body;

    // Validate required fields
    if (!email || !task || !round || !nonce || !secret) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate secret
    if (secret !== EXPECTED_SECRET) {
      console.log('Invalid secret provided');
      return res.status(403).json({ error: 'Invalid secret' });
    }

    console.log(`✓ Secret validated`);
    console.log(`✓ Processing task: ${task}`);

    // Step 1: Generate code using Groq
    console.log('Generating code with Groq AI...');
    const generatedFiles = await generateAppCode(brief, attachments, task);
    console.log('✓ Code generated');

    // Step 2: Create GitHub repository
    console.log('Creating GitHub repository...');
    const repoName = sanitizeRepoName(task);
    const username = await getGitHubUsername();
    const repo = await createGitHubRepo(repoName, brief);
    console.log(`✓ Repository created: ${repo.data.html_url}`);

    // Step 3: Push code to repository
    console.log('Pushing code to repository...');
    const commitSha = await pushCodeToRepo(username, repoName, generatedFiles);
    console.log(`✓ Code pushed, commit: ${commitSha}`);

    // Step 4: Enable GitHub Pages
    console.log('Enabling GitHub Pages...');
    await enableGitHubPages(username, repoName);
    console.log('✓ GitHub Pages enabled');

    // Wait for GitHub Pages to deploy (30 seconds)
    console.log('Waiting for GitHub Pages to deploy...');
    await sleep(30000);

    const pagesUrl = `https://${username}.github.io/${repoName}/`;
    console.log(`✓ Pages URL: ${pagesUrl}`);

    // Step 5: Report to evaluation URL
    console.log('Reporting to evaluation URL...');
    await reportToEvaluationUrl(
      email, 
      task, 
      round, 
      nonce, 
      repo.data.html_url, 
      commitSha, 
      pagesUrl
    );
    console.log('✓ Reported to evaluation URL');

    // Success response
    res.status(200).json({
      success: true,
      repo_url: repo.data.html_url,
      pages_url: pagesUrl,
      commit_sha: commitSha,
      message: 'Application created successfully!'
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ 
      error: error.message,
      details: error.response?.data || error.stack 
    });
  }
});

// Get GitHub username
async function getGitHubUsername() {
  const { data } = await octokit.users.getAuthenticated();
  return data.login;
}

// Sanitize repository name
function sanitizeRepoName(task) {
  const timestamp = Date.now();
  return `${task}-${timestamp}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 100);
}

// Generate application code using Groq (FREE!)
async function generateAppCode(brief, attachments, task) {
  const prompt = `Create a complete, production-ready single-page web application.

Task: ${task}
Brief: ${brief}
Attachments: ${JSON.stringify(attachments)}

Requirements:
1. Create ONE self-contained HTML file with embedded CSS and JavaScript
2. Make it visually beautiful with modern design
3. Make it fully functional and interactive
4. Use modern JavaScript (ES6+)
5. Include responsive design for mobile
6. Add smooth animations and transitions
7. Use a professional color scheme
8. Include clear instructions for the user

Return ONLY the complete HTML code, nothing else. No markdown, no explanations.`;

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile', // Fast and free!
        messages: [
          {
            role: 'system',
            content: 'You are an expert full-stack developer who creates beautiful, functional web applications. Output only raw HTML code without any markdown formatting or code blocks.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 8000
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 second timeout
      }
    );

    let htmlContent = response.data.choices[0].message.content;
    
    // Remove markdown code blocks if present
    htmlContent = htmlContent.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();

    const readmeContent = `# ${task}

## Description
${brief}

## Live Demo
Visit the GitHub Pages URL to see the live application.

## Setup
Simply open \`index.html\` in a modern web browser.

## Features
- Modern, responsive design
- Fully functional interface
- Mobile-friendly
- Fast and lightweight

## License
MIT License

## Generated
This application was automatically generated using Groq AI.`;

    return {
      'index.html': htmlContent,
      'README.md': readmeContent
    };
  } catch (error) {
    console.error('Groq API Error:', error.response?.data || error.message);
    throw new Error(`Failed to generate code with Groq: ${error.message}`);
  }
}

// Create GitHub repository
async function createGitHubRepo(repoName, description) {
  try {
    const repo = await octokit.repos.createForAuthenticatedUser({
      name: repoName,
      description: description || 'Auto-generated application',
      private: false,
      auto_init: true,
      license_template: 'mit'
    });
    
    // Wait a bit for repo to initialize
    await sleep(2000);
    
    return repo;
  } catch (error) {
    if (error.status === 422) {
      // Repo name already exists, add random suffix
      const newName = `${repoName}-${Math.random().toString(36).substring(7)}`;
      return createGitHubRepo(newName, description);
    }
    throw error;
  }
}

// Push code to repository
async function pushCodeToRepo(owner, repo, files) {
  // Get the default branch reference
  const { data: refs } = await octokit.git.getRef({
    owner,
    repo,
    ref: 'heads/main'
  });
  const commitSha = refs.object.sha;

  // Get the commit
  const { data: commit } = await octokit.git.getCommit({
    owner,
    repo,
    commit_sha: commitSha
  });
  const treeSha = commit.tree.sha;

  // Create blobs for each file
  const blobs = await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const { data: blob } = await octokit.git.createBlob({
        owner,
        repo,
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64'
      });
      return {
        path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha
      };
    })
  );

  // Create new tree
  const { data: newTree } = await octokit.git.createTree({
    owner,
    repo,
    tree: blobs,
    base_tree: treeSha
  });

  // Create new commit
  const { data: newCommit } = await octokit.git.createCommit({
    owner,
    repo,
    message: 'Deploy application',
    tree: newTree.sha,
    parents: [commitSha]
  });

  // Update main branch reference
  await octokit.git.updateRef({
    owner,
    repo,
    ref: 'heads/main',
    sha: newCommit.sha
  });

  return newCommit.sha;
}

// Enable GitHub Pages
async function enableGitHubPages(owner, repo) {
  try {
    await octokit.repos.createPagesSite({
      owner,
      repo,
      source: {
        branch: 'main',
        path: '/'
      }
    });
  } catch (error) {
    if (error.status === 409) {
      console.log('GitHub Pages already enabled');
    } else {
      console.log('Pages setup response:', error.message);
    }
  }
}

// Report to evaluation URL with retries
async function reportToEvaluationUrl(email, task, round, nonce, repoUrl, commitSha, pagesUrl) {
  const payload = {
    email,
    task,
    round,
    nonce,
    repo_url: repoUrl,
    commit_sha: commitSha,
    pages_url: pagesUrl
  };

  const delays = [1000, 2000, 4000, 8000, 16000];

  for (let i = 0; i < delays.length; i++) {
    try {
      console.log(`Reporting attempt ${i + 1}/${delays.length}...`);
      
      const response = await axios.post(EVALUATION_URL, payload, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      if (response.status === 200) {
        console.log('✓ Successfully reported to evaluation URL');
        return;
      }
    } catch (error) {
      console.log(`Attempt ${i + 1} failed:`, error.message);
      
      if (i < delays.length - 1) {
        console.log(`Waiting ${delays[i]}ms before retry...`);
        await sleep(delays[i]);
      }
    }
  }

  throw new Error('Failed to report to evaluation URL after all retries');
}

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Endpoint: http://localhost:${PORT}/api-endpoint`);
  console.log('✓ Using Groq AI (FREE & FAST)');
  console.log('✓ Ready to receive requests');
});