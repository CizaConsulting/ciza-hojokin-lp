import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// 記事本文の「# 見出し」（H1）を取り除く。
// 記事ページのテンプレート（src/pages/blog/[...slug].astro）が title を H1 として出しているため、
// 本文側の H1 があるとページに H1 が2つ並ぶ（既存記事は全件そうなっていた）。
function removeBodyH1() {
  return (tree) => {
    tree.children = tree.children.filter((node) => !(node.type === 'heading' && node.depth === 1));
  };
}

export default defineConfig({
  site: 'https://hojokin.ciza.co.jp',
  markdown: { remarkPlugins: [removeBodyH1] },
  integrations: [sitemap()],
});
