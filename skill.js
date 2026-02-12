/**
 * AgentWeb OpenClaw Skill
 * Provides web rendering functions for AI agents
 */

const { spawn } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const fs = require('fs').promises;

const PROTOTYPE_DIR = path.join(__dirname, 'prototype');

/**
 * Execute AgentWeb CLI and return parsed output
 */
async function runAgentWeb(url, options = {}) {
    return new Promise((resolve, reject) => {
        const args = [path.join(PROTOTYPE_DIR, 'cli.js'), url];
        
        if (options.format === 'summary') {
            args.push('--summary');
        }
        
        if (options.screenshot) {
            args.push('--screenshot');
        }

        const child = spawn('node', args, {
            cwd: PROTOTYPE_DIR,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`AgentWeb failed: ${stderr}`));
                return;
            }

            try {
                if (options.format === 'summary') {
                    resolve(stdout.trim());
                } else {
                    resolve(JSON.parse(stdout));
                }
            } catch (err) {
                reject(new Error(`Failed to parse AgentWeb output: ${err.message}`));
            }
        });

        child.on('error', (err) => {
            reject(new Error(`Failed to start AgentWeb: ${err.message}`));
        });
    });
}

/**
 * Render a web page to structured data
 */
async function agentWeb(url, options = {}) {
    if (!url || typeof url !== 'string') {
        throw new Error('URL is required and must be a string');
    }

    try {
        const result = await runAgentWeb(url, options);
        return result;
    } catch (error) {
        // Add context to errors
        throw new Error(`AgentWeb render failed for ${url}: ${error.message}`);
    }
}

/**
 * Create an interactive web session (placeholder for future implementation)
 */
async function agentWebInteractive(url) {
    // This would create a persistent browser session
    // For now, return a simplified interface
    
    const InteractiveSession = {
        url,
        async render() {
            return await agentWeb(url);
        },
        
        async click(elementId) {
            throw new Error('Interactive sessions not yet implemented. Use basic agentWeb() for now.');
        },
        
        async type(elementId, text) {
            throw new Error('Interactive sessions not yet implemented. Use basic agentWeb() for now.');
        },
        
        async submit(formId) {
            throw new Error('Interactive sessions not yet implemented. Use basic agentWeb() for now.');
        },
        
        async navigate(newUrl) {
            this.url = newUrl;
            return await this.render();
        },
        
        async close() {
            // Nothing to clean up yet
        }
    };

    return InteractiveSession;
}

/**
 * Quick helper to get a human-readable page summary
 */
async function agentWebSummary(url) {
    return await agentWeb(url, { format: 'summary' });
}

/**
 * Check if AgentWeb is properly installed
 */
async function checkAgentWebInstallation() {
    try {
        // Check if prototype directory exists
        const stat = await fs.stat(PROTOTYPE_DIR);
        if (!stat.isDirectory()) {
            return { installed: false, error: 'Prototype directory not found' };
        }

        // Check if dependencies are installed
        const nodeModulesPath = path.join(PROTOTYPE_DIR, 'node_modules');
        const nodeModulesStat = await fs.stat(nodeModulesPath);
        if (!nodeModulesStat.isDirectory()) {
            return { 
                installed: false, 
                error: 'Dependencies not installed. Run: cd ventures/agentweb/prototype && npm install' 
            };
        }

        // Quick functionality test
        await runAgentWeb('https://example.com');
        
        return { installed: true };
    } catch (error) {
        return { 
            installed: false, 
            error: `AgentWeb check failed: ${error.message}` 
        };
    }
}

module.exports = {
    agentWeb,
    agentWebInteractive,
    agentWebSummary,
    checkAgentWebInstallation
};