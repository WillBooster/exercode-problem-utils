import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { htmlJudgePreset } from '@exercode/problem-utils-browser';

await htmlJudgePreset({
  solutionDirectoryPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'model_answers', 'default'),
  requiredFiles: ['index.html', 'style.css'],
});
