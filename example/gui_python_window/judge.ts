import { DecisionCode } from '@exercode/problem-utils';
import { guiCommandJudgePreset } from '@exercode/problem-utils/presets/guiCommand';
import type { GuiCommandRunResult } from '@exercode/problem-utils/presets/guiCommand';

const mockScreenshotPath = process.env.MOCK_GUI_SCREENSHOT_PATH;
const mockRecordingPath = process.env.MOCK_GUI_RECORDING_PATH;

await guiCommandJudgePreset(import.meta.dirname, {
  mainFilePath: 'main.py',
  runTimeoutSeconds: 5,
  recordsAnimation: true,
  readTestCases: () => Promise.resolve([{ id: 'default' }]),
  command: () => ['python3', 'main.py'],
  ...(mockScreenshotPath
    ? {
        runCommand: ({ stdin }) =>
          ({
            stdin,
            stdout: '',
            stderr: '',
            status: 0,
            timeSeconds: 0.1,
            memoryBytes: 0,
            screenshots: [{ path: mockScreenshotPath, data: 'mock-image', encoding: 'base64' }],
            // A window that keeps animating is recorded until the time limit stops the run.
            ...(mockRecordingPath
              ? {
                  recordings: [{ path: mockRecordingPath, data: 'mock-animation', encoding: 'base64' }],
                  stopReason: 'timeout',
                }
              : { stopReason: 'stable_screenshot' }),
          }) satisfies GuiCommandRunResult,
      }
    : {}),
  test: ({ runResult }) => {
    // A window that is still animating at the time limit is fine; a program that shows nothing is not.
    if (runResult.stopReason === 'timeout' && runResult.recordings.length === 0) {
      return {
        decisionCode: DecisionCode.TIME_LIMIT_EXCEEDED,
        feedbackMarkdown: 'GUI プログラムの実行が時間内に終了しませんでした。',
      };
    }

    if ((runResult.status ?? 0) !== 0) {
      return {
        decisionCode: DecisionCode.RUNTIME_ERROR,
        stderr: runResult.stderr,
        feedbackMarkdown: '実行時エラーが発生しました。',
      };
    }

    if (runResult.screenshots.length !== 1) {
      return {
        decisionCode: DecisionCode.WRONG_ANSWER,
        feedbackMarkdown: 'ウィンドウは1つだけ表示してください。',
      };
    }

    const [screenshot] = runResult.screenshots;
    if (!screenshot || !screenshot.path.includes('Hello_Window')) {
      return {
        decisionCode: DecisionCode.WRONG_ANSWER,
        feedbackMarkdown: 'タイトルが `Hello Window` のウィンドウを表示してください。',
      };
    }

    return { decisionCode: DecisionCode.ACCEPTED, outputFiles: [...runResult.screenshots, ...runResult.recordings] };
  },
});
