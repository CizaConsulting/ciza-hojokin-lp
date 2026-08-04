import fs from 'node:fs/promises';
import { updatePage } from './lib.mjs';

let result;
try {
  result = JSON.parse(await fs.readFile('.blog-publish-result.json', 'utf8'));
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log(JSON.stringify({ finalized: false, reason: 'No article was prepared' }));
    process.exit(0);
  }
  throw error;
}

await updatePage(result.page_id, result.notion_updates);
await fs.rm('.blog-publish-result.json', { force: true });
console.log(JSON.stringify({
  finalized: true,
  title: result.title,
  article_type: result.article_type,
  published_url: result.published_url,
}, null, 2));
