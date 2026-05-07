/**
 * Replays Dashboard Slack Bot
 * Node.js + Express implementation
 * 
 * Deploy to: Heroku, Railway, Render, or your own server
 * Usage: node server.js
 */

const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Environment variables
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

// In-memory cache (use database in production)
let reviewsCache = [];
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch reviews from Google Drive using Claude API
 */
async function fetchReviewsFromDrive() {
  const now = Date.now();
  if (reviewsCache.length > 0 && now - lastFetchTime < CACHE_DURATION) {
    return reviewsCache;
  }

  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: `Search the Google Drive for all documents in the "Employees - Performance Management" shared drive that match the pattern "Replays - * 2026". Return as JSON array with: id (file ID), employee (name), manager (name), department (department), status (Draft/In Progress/Finalized), snippet (first 150 chars of self-review).`
        }
      ],
      mcp_servers: [
        {
          type: 'url',
          url: 'https://drivemcp.googleapis.com/mcp/v1',
          name: 'google-drive'
        }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${ANTHROPIC_API_KEY}`
      }
    });

    // Parse response and extract reviews
    const reviews = parseClaudeResponse(response.data);
    reviewsCache = reviews;
    lastFetchTime = now;
    return reviews;
  } catch (error) {
    console.error('Error fetching reviews:', error.message);
    return reviewsCache; // Return cached data on error
  }
}

/**
 * Parse Claude's response to extract reviews
 */
function parseClaudeResponse(data) {
  try {
    const content = data.content[0].text;
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (error) {
    console.error('Error parsing response:', error.message);
  }
  return [];
}

/**
 * Build Slack Block Kit blocks for review list
 */
function buildReviewBlocks(reviews, filter = '') {
  const filtered = reviews
    .filter(r => 
      r.employee.toLowerCase().includes(filter.toLowerCase()) ||
      r.manager.toLowerCase().includes(filter.toLowerCase())
    )
    .sort((a, b) => {
      const statusOrder = { 'Draft': 0, 'In Progress': 1, 'Finalized': 2 };
      return statusOrder[a.status] - statusOrder[b.status];
    });

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '📋 Replays 2026',
        emoji: true
      }
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Found *${filtered.length}* reviews${filter ? ` matching "${filter}"` : ''}`
        }
      ]
    },
    {
      type: 'divider'
    }
  ];

  // Add reviews (limit to 20 in modal)
  filtered.slice(0, 20).forEach(review => {
    const statusEmoji = {
      'Finalized': '✅',
      'In Progress': '⏳',
      'Draft': '📝'
    }[review.status] || '•';

    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${review.employee}*\n${statusEmoji} ${review.status} | ${review.department} | Manager: ${review.manager}`
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View & Feedback',
            emoji: true
          },
          value: review.id,
          action_id: 'select_review',
          style: 'primary'
        }
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `_${review.snippet.substring(0, 100)}${review.snippet.length > 100 ? '...' : ''}_`
          }
        ]
      }
    );
  });

  if (filtered.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'No reviews found matching your search.'
      }
    });
  }

  blocks.push({
    type: 'divider'
  });

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: 'Tip: Use `/replays [name]` to search'
      }
    ]
  });

  return blocks;
}

/**
 * Handle /replays slash command
 */
app.post('/slack/slash-replays', async (req, res) => {
  const { user_id, trigger_id, text, channel_id } = req.body;

  try {
    // Fetch reviews from Google Drive
    const reviews = await fetchReviewsFromDrive();
    
    if (reviews.length === 0) {
      return res.json({
        response_type: 'ephemeral',
        text: 'Could not load reviews. Check that documents are named "Replays - [Name] 2026" in the Employees - Performance Management drive.'
      });
    }

    // Build blocks for modal
    const blocks = buildReviewBlocks(reviews, text);

    // Open modal
    const modalResponse = await axios.post(
      'https://slack.com/api/views.open',
      {
        trigger_id: trigger_id,
        view: {
          type: 'modal',
          callback_id: 'review_modal',
          title: {
            type: 'plain_text',
            text: 'Replays 2026',
            emoji: true
          },
          blocks: blocks
        }
      },
      {
        headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` }
      }
    );

    if (!modalResponse.data.ok) {
      console.error('Slack API error:', modalResponse.data.error);
      return res.status(500).json({ error: 'Failed to open modal' });
    }

    res.send();
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Handle interactive actions (button clicks, etc.)
 */
app.post('/slack/actions', async (req, res) => {
  const payload = JSON.parse(req.body.payload);
  const { type, trigger_id, actions, user } = payload;

  try {
    if (type === 'block_actions') {
      const action = actions[0];

      if (action.action_id === 'select_review') {
        const reviewId = action.value;
        const reviews = await fetchReviewsFromDrive();
        const review = reviews.find(r => r.id === reviewId);

        if (review) {
          // Open review detail modal
          const detailBlocks = [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: review.employee,
                emoji: true
              }
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Manager*\n${review.manager}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Department*\n${review.department}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Status*\n${review.status}`
                }
              ]
            },
            {
              type: 'divider'
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Self-Review Excerpt*\n${review.snippet}`
              }
            },
            {
              type: 'divider'
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: '✨ Generate Feedback',
                    emoji: true
                  },
                  value: reviewId,
                  action_id: 'generate_feedback',
                  style: 'primary'
                },
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: '📄 Open in Google Docs',
                    emoji: true
                  },
                  url: `https://docs.google.com/document/d/${reviewId}`,
                  style: 'primary'
                }
              ]
            }
          ];

          await axios.post(
            'https://slack.com/api/views.update',
            {
              trigger_id: trigger_id,
              view: {
                type: 'modal',
                callback_id: 'review_detail',
                title: {
                  type: 'plain_text',
                  text: review.employee,
                  emoji: true
                },
                private_metadata: JSON.stringify(review),
                blocks: detailBlocks
              }
            },
            {
              headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` }
            }
          );
        }
      } else if (action.action_id === 'generate_feedback') {
        const review = JSON.parse(payload.view.private_metadata);
        
        // Generate feedback with Claude
        const feedbackResponse = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 600,
            messages: [
              {
                role: 'user',
                content: `Generate 3-4 specific, actionable feedback points for this employee's performance review. Include strengths and areas for growth.

Employee: ${review.employee}
Department: ${review.department}
Manager: ${review.manager}
Self-assessment: ${review.snippet}

Format as bullet points ready to paste into a Google Doc.`
              }
            ]
          },
          {
            headers: { 'Authorization': `Bearer ${ANTHROPIC_API_KEY}` }
          }
        );

        const feedback = feedbackResponse.data.content[0].text;

        // Post feedback to user
        await axios.post(
          'https://slack.com/api/chat.postMessage',
          {
            channel: user.id,
            text: `Feedback for ${review.employee}`,
            blocks: [
              {
                type: 'header',
                text: {
                  type: 'plain_text',
                  text: `✨ Feedback for ${review.employee}`,
                  emoji: true
                }
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: feedback
                }
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: '💡 Copy this feedback, personalize it, and paste into their review doc'
                  }
                ]
              }
            ]
          },
          {
            headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` }
          }
        );

        res.send();
      }
    }

    res.send();
  } catch (error) {
    console.error('Action error:', error.message);
    res.status(500).json({ error: 'Failed to process action' });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log(`Replays Slack Bot running on port ${PORT}`);
  console.log(`Make sure these environment variables are set:`);
  console.log(`  - SLACK_BOT_TOKEN`);
  console.log(`  - SLACK_SIGNING_SECRET`);
  console.log(`  - ANTHROPIC_API_KEY`);
});

module.exports = app;
