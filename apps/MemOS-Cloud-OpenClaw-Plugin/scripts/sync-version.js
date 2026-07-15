import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the updated package.json to get the new version
const packageJsonPath = path.resolve(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const newVersion = packageJson.version;

console.log(`Syncing version to ${newVersion}...`);

const filesToUpdate = [
  'openclaw.plugin.json',
  'moltbot.plugin.json',
  'clawdbot.plugin.json'
];

filesToUpdate.forEach(fileName => {
  const filePath = path.resolve(__dirname, '..', fileName);
  
  if (fs.existsSync(filePath)) {
    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      if (content.version !== newVersion) {
        content.version = newVersion;
        // Write back with 2 spaces indentation and a newline at the end
        fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n', 'utf8');
        console.log(`Updated ${fileName} to version ${newVersion}`);
      } else {
        console.log(`${fileName} is already at version ${newVersion}`);
      }
    } catch (error) {
      console.error(`Error updating ${fileName}:`, error.message);
      process.exit(1);
    }
  } else {
    console.warn(`Warning: ${fileName} not found, skipping.`);
  }
});

console.log('Version sync complete.');
