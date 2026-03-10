/**
 * Task summary generator using LLM APIs
 *
 * Generates short, descriptive titles for tasks (like ChatGPT's conversation titles).
 * Uses the first available API key, preferring Anthropic for speed/cost.
 */

import { getApiKey, type ApiKeyProvider } from '../store/secureStorage';

const SUMMARY_PROMPT = `Generate a very short title (3-5 words max) that summarizes this task request.
The title should be in sentence case, no quotes, no punctuation at end.
Examples: "Check calendar", "Download invoice", "Search flights to Paris"

Task: `;

/**
 * Generate a short summary title for a task prompt
 * @param prompt The user's task prompt
 * @returns A short summary string, or truncated prompt as fallback
 */
export async function generateTaskSummary(prompt: string): Promise<string> {
  // Try providers in order of preference
  const providers: ApiKeyProvider[] = ['anthropic', 'openai', 'google', 'xai'];

  for (const provider of providers) {
    const apiKey = getApiKey(provider);
    if (!apiKey) continue;

    try {
      const summary = await callProvider(provider, apiKey, prompt);
      if (summary) {
        console.log(`[Summarizer] Generated summary using ${provider}: "${summary}"`);
        return summary;
      }
    } catch (error) {
      console.warn(`[Summarizer] ${provider} failed:`, error);
      // Continue to next provider
    }
  }

  // Fallback: truncate prompt
  console.log('[Summarizer] All providers failed, using truncated prompt');
  return truncatePrompt(prompt);
}

async function callProvider(
  provider: ApiKeyProvider,
  apiKey: string,
  prompt: string
): Promise<string | null> {
  switch (provider) {
    case 'anthropic':
      return callAnthropic(apiKey, prompt);
    case 'openai':
      return callOpenAI(apiKey, prompt);
    case 'google':
      return callGoogle(apiKey, prompt);
    case 'xai':
      return callXAI(apiKey, prompt);
    default:
      return null;
  }
}

async function callAnthropic(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: SUMMARY_PROMPT + prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.[0]?.text;
  return cleanSummary(text || '');
}

async function callOpenAI(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: SUMMARY_PROMPT + prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  return cleanSummary(text || '');
}

async function callGoogle(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: SUMMARY_PROMPT + prompt }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 50,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Google API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return cleanSummary(text || '');
}

async function callXAI(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-3',
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: SUMMARY_PROMPT + prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`xAI API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  return cleanSummary(text || '');
}

/**
 * Clean up the generated summary
 */
function cleanSummary(text: string): string {
  return (
    text
      // Remove surrounding quotes
      .replace(/^["']|["']$/g, '')
      // Remove trailing punctuation
      .replace(/[.!?]+$/, '')
      // Trim whitespace
      .trim()
  );
}

/**
 * Fallback: truncate prompt to a reasonable length
 */
function truncatePrompt(prompt: string, maxLength = 30): string {
  const cleaned = prompt.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.slice(0, maxLength - 3) + '...';
}
