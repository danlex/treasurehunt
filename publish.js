#!/usr/bin/env node
// Moves the first item from queue.json into posts.json (prepended) with a publish timestamp.
// Exits non-zero with a clear message if the queue is empty.

const fs = require('fs');
const path = require('path');

const root = __dirname;
const queuePath = path.join(root, 'queue.json');
const postsPath = path.join(root, 'posts.json');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

const queue = readJson(queuePath);
if (!queue.length) {
  console.error('Queue is empty — nothing to publish.');
  process.exit(2);
}

const posts = readJson(postsPath);
const [next, ...rest] = queue;

const published = {
  ...next,
  publishedAt: new Date().toISOString()
};

posts.unshift(published);
writeJson(queuePath, rest);
writeJson(postsPath, posts);

console.log(`Published: ${published.title}`);
