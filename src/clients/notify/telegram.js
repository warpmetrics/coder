// Telegram notification channel — posts to a supergroup with forum topics.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const TOPIC_MAP_FILE = 'telegram-topics.json';
const MAX_MESSAGE_LENGTH = 4096;
const MAX_TOPIC_NAME_LENGTH = 128;

function githubToTelegramHtml(md) {
  let s = md;
  // Strip HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Strip <details>/<summary> tags, keep inner content
  s = s.replace(/<\/?details>/g, '');
  s = s.replace(/<\/?summary>/g, '');
  // Fenced code blocks → <pre>
  s = s.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => `<pre>${escapeHtml(code.trimEnd())}</pre>`);
  // Inline code
  s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Escape remaining HTML entities in plain text (outside existing tags)
  s = escapeHtmlOutsideTags(s);
  // Truncate
  if (s.length > MAX_MESSAGE_LENGTH) {
    s = s.slice(0, MAX_MESSAGE_LENGTH - 20) + '\n\n(truncated)';
  }
  return s;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlOutsideTags(html) {
  // Split on known tags, only escape text segments
  return html.replace(/([^<]*?)(<\/?(?:b|code|pre|a(?:\s[^>]*)?)>)/g, (_, text, tag) => {
    return text.replace(/&(?!amp;|lt;|gt;)/g, '&amp;').replace(/<(?!\/?(?:b|code|pre|a)[ >])/g, '&lt;').replace(/>(?!$)/g, (m, offset, str) => {
      // Don't escape > that are part of tags we already processed
      return '&gt;';
    }) + tag;
  });
}

function loadTopicMap(mapPath) {
  if (!existsSync(mapPath)) return {};
  try { return JSON.parse(readFileSync(mapPath, 'utf-8')); } catch { return {}; }
}

function saveTopicMap(mapPath, map) {
  mkdirSync(dirname(mapPath), { recursive: true });
  writeFileSync(mapPath, JSON.stringify(map, null, 2) + '\n');
}

export function create({ chatId, botToken, configDir }) {
  if (!botToken || !chatId) return { comment() {} };

  const mapPath = join(configDir, TOPIC_MAP_FILE);

  async function telegramApi(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
  }

  async function getOrCreateTopic(issueId, title) {
    const map = loadTopicMap(mapPath);
    const key = String(issueId);
    if (map[key]) return map[key];

    const topicName = `#${issueId}: ${title || 'Issue'}`.slice(0, MAX_TOPIC_NAME_LENGTH);
    try {
      const topic = await telegramApi('createForumTopic', { chat_id: chatId, name: topicName });
      map[key] = topic.message_thread_id;
      saveTopicMap(mapPath, map);
      return topic.message_thread_id;
    } catch {
      // Topics not enabled — fall back to flat messages
      return null;
    }
  }

  return {
    comment(issueId, { body, title }) {
      // Fire-and-forget
      (async () => {
        try {
          const topicId = await getOrCreateTopic(issueId, title);
          const msg = { chat_id: chatId, text: githubToTelegramHtml(body), parse_mode: 'HTML' };
          if (topicId) msg.message_thread_id = topicId;
          await telegramApi('sendMessage', msg);
        } catch {}
      })();
    },
  };
}
