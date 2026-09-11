const { markdownToPdf } = require('@exercode/problem-utils-browser/pdf');

markdownToPdf('これは**人工知能（AI）**という技術です。', { assetDirectoryPath: process.cwd() })
  .then((pdf) => process.stdout.write(pdf))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
