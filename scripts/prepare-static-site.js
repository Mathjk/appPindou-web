const fs = require('fs');
const path = require('path');

const distDir = path.resolve(__dirname, '..', 'dist');
const indexPath = path.join(distDir, 'index.html');

if (!fs.existsSync(indexPath)) {
  throw new Error(`Missing ${indexPath}. Run expo export before preparing the static site.`);
}

fs.writeFileSync(path.join(distDir, '.nojekyll'), '');
fs.copyFileSync(indexPath, path.join(distDir, '404.html'));

console.log('Prepared static site for GitHub Pages.');
