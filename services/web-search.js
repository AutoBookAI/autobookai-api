/**
 * Web search with citations.
 *
 * Uses a search API to find results, then returns them with source URLs.
 * The AI agent is instructed to always cite these sources in its responses.
 *
 * Supports:
 *  1. Brave Search API (preferred — good quality, generous free tier)
 *  2. Fallback: SerpAPI / Google Custom Search
 */

const axios = require('axios');

/**
 * Search the web and return results with source URLs.
 *
 * @param {string} query - Search query
 * @param {number} [count=5] - Number of results
 * @returns {Array<{ title, url, snippet }>}
 */
async function search(query, count = 5) {
  if (!query) throw new Error('Missing search query');

  // Try Brave Search first
  if (process.env.BRAVE_SEARCH_API_KEY) {
    return braveSearch(query, count);
  }

  // Fallback to SerpAPI
  if (process.env.SERP_API_KEY) {
    return serpApiSearch(query, count);
  }

  throw new Error('No search API configured. Set BRAVE_SEARCH_API_KEY or SERP_API_KEY.');
}

async function braveSearch(query, count) {
  const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    params: { q: query, count },
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY,
    },
    timeout: 10000,
  });

  return (res.data.web?.results || []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

async function serpApiSearch(query, count) {
  const res = await axios.get('https://serpapi.com/search.json', {
    params: {
      q: query,
      api_key: process.env.SERP_API_KEY,
      num: count,
    },
    timeout: 10000,
  });

  return (res.data.organic_results || []).map(r => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
  }));
}

/**
 * Fetch and extract text from a webpage (for reading full articles).
 * Strips HTML, returns plain text up to maxLength.
 */
async function fetchPage(url, maxLength = 5000) {
  if (!url) throw new Error('Missing URL');

  const res = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'AI-Assistant/1.0' },
    maxRedirects: 3,
  });

  // Basic HTML → text extraction
  let text = res.data;
  if (typeof text === 'string') {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return {
    url,
    text: text.slice(0, maxLength),
    truncated: text.length > maxLength,
  };
}

module.exports = { search, fetchPage };
