const NOTION_VERSION = '2026-03-11';

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function notion(path, options = {}) {
  const token = requireEnv('NOTION_TOKEN');
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Notion ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

export function queryDataSource(dataSourceId, body = {}) {
  return notion(`/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function retrieveDataSource(dataSourceId) {
  return notion(`/data_sources/${dataSourceId}`);
}

export function updatePage(pageId, properties) {
  return notion(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  });
}

export function createPage(dataSourceId, properties, children) {
  return notion('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties,
      children,
    }),
  });
}

export async function getAllBlocks(blockId) {
  const blocks = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ page_size: '100' });
    if (cursor) qs.set('start_cursor', cursor);
    const data = await notion(`/blocks/${blockId}/children?${qs}`);
    for (const block of data.results || []) {
      blocks.push(block);
      if (block.has_children) block.children = await getAllBlocks(block.id);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

export function richTextToPlain(items = []) {
  return items.map((item) => item.plain_text || item.text?.content || '').join('');
}

export function richTextToMarkdown(items = []) {
  return items.map((item) => {
    const text = item.plain_text || item.text?.content || '';
    const href = item.href || item.text?.link?.url;
    return href ? `[${text}](${href})` : text;
  }).join('');
}

export function getTitle(page) {
  for (const prop of Object.values(page.properties || {})) {
    if (prop.type === 'title') return richTextToPlain(prop.title);
  }
  return '';
}

export function getPropertyValue(page, propertyName) {
  const prop = page.properties?.[propertyName];
  if (!prop) return '';
  if (prop.type === 'title') return richTextToPlain(prop.title);
  if (prop.type === 'rich_text') return richTextToPlain(prop.rich_text);
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'status') return prop.status?.name || '';
  if (prop.type === 'url') return prop.url || '';
  if (prop.type === 'date') return prop.date?.start || '';
  if (prop.type === 'multi_select') return (prop.multi_select || []).map((item) => item.name);
  return '';
}

export function blocksToMarkdown(blocks, depth = 0) {
  const lines = [];
  for (const block of blocks || []) {
    const data = block[block.type] || {};
    const text = richTextToMarkdown(data.rich_text || []);
    if (block.type === 'heading_1') lines.push(`# ${text}`);
    else if (block.type === 'heading_2') lines.push(`## ${text}`);
    else if (block.type === 'heading_3') lines.push(`### ${text}`);
    else if (block.type === 'paragraph') lines.push(text);
    else if (block.type === 'quote') lines.push(`> ${text}`);
    else if (block.type === 'bulleted_list_item') lines.push(`${'  '.repeat(depth)}- ${text}`);
    else if (block.type === 'numbered_list_item') lines.push(`${'  '.repeat(depth)}1. ${text}`);
    else if (block.type === 'divider') lines.push('---');
    else if (block.type === 'code') lines.push(`\`\`\`${data.language || ''}\n${text}\n\`\`\``);
    else if (text) lines.push(text);
    if (block.children?.length) lines.push(blocksToMarkdown(block.children, depth + 1));
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function textRich(content, link) {
  return [{
    type: 'text',
    text: {
      content: content.slice(0, 2000),
      ...(link ? { link: { url: link } } : {}),
    },
  }];
}

function inlineMarkdownToRichText(text) {
  const items = [];
  const regex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let last = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) items.push(...textRich(text.slice(last, match.index)));
    items.push(...textRich(match[1], match[2]));
    last = regex.lastIndex;
  }
  if (last < text.length) items.push(...textRich(text.slice(last)));
  return items.length ? items : textRich(text);
}

export function markdownToBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split(/\r?\n/);
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    const text = paragraph.join('\n').trim();
    if (text) {
      for (let i = 0; i < text.length; i += 1800) {
        blocks.push({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: inlineMarkdownToRichText(text.slice(i, i + 1800)) },
        });
      }
    }
    paragraph = [];
  };

  for (const line of lines) {
    if (!line.trim()) { flush(); continue; }
    if (line.startsWith('### ')) {
      flush();
      blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: inlineMarkdownToRichText(line.slice(4)) } });
      continue;
    }
    if (line.startsWith('## ')) {
      flush();
      blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: inlineMarkdownToRichText(line.slice(3)) } });
      continue;
    }
    if (line.startsWith('# ')) {
      flush();
      blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: inlineMarkdownToRichText(line.slice(2)) } });
      continue;
    }
    if (line.startsWith('> ')) {
      flush();
      blocks.push({ object: 'block', type: 'quote', quote: { rich_text: inlineMarkdownToRichText(line.slice(2)) } });
      continue;
    }
    if (line.startsWith('- ')) {
      flush();
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: inlineMarkdownToRichText(line.slice(2)) } });
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      flush();
      blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: inlineMarkdownToRichText(line.replace(/^\d+\.\s/, '')) } });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks.slice(0, 100);
}

export function findProperty(schema, preferredNames, type) {
  for (const name of preferredNames) {
    if (schema.properties?.[name]?.type === type) return name;
  }
  return Object.entries(schema.properties || {}).find(([, prop]) => prop.type === type)?.[0];
}

function richText(content) {
  return [{ type: 'text', text: { content: String(content).slice(0, 2000) } }];
}

export function makeProperty(type, value) {
  if (type === 'title') return { title: richText(value) };
  if (type === 'rich_text') return { rich_text: richText(value) };
  if (type === 'url') return { url: value || null };
  if (type === 'date') return { date: value ? { start: value } : null };
  if (type === 'select') return { select: value ? { name: value } : null };
  if (type === 'status') return { status: value ? { name: value } : null };
  if (type === 'multi_select') return { multi_select: (value || []).map((name) => ({ name })) };
  throw new Error(`Unsupported property type: ${type}`);
}

export async function openAIJson({ instructions, input, schema, name }) {
  const apiKey = requireEnv('OPENAI_API_KEY');
  const model = process.env.OPENAI_MODEL || 'gpt-5.4';
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      instructions,
      input,
      text: { format: { type: 'json_schema', name, strict: true, schema } },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${JSON.stringify(data)}`);
  const outputText = data.output_text
    || data.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
  if (!outputText) throw new Error(`OpenAI returned no output text: ${JSON.stringify(data)}`);
  return JSON.parse(outputText);
}

export function slugIsSafe(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

export function escapeYaml(value) {
  return JSON.stringify(String(value ?? ''));
}

export function splitKeywords(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value || '')
    .split(/[、,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
