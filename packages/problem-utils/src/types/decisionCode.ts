export const DecisionCode = {
  /** ジャッジ待ち */
  WAITING_JUDGE: 0,

  /** ジャッジ利用不可 */
  JUDGE_NOT_AVAILABLE: 1,

  /** 不正解 */
  WRONG_ANSWER: 1000,

  /** 実行時エラー */
  RUNTIME_ERROR: 1001,

  /** 時間制限超過 */
  TIME_LIMIT_EXCEEDED: 1002,

  /** メモリ制限超過 */
  MEMORY_LIMIT_EXCEEDED: 1003,

  /** 出力サイズ制限超過 */
  OUTPUT_SIZE_LIMIT_EXCEEDED: 1004,

  /** 出力形式エラー */
  PRESENTATION_ERROR: 1005,

  /** コード中の禁止された表現 */
  FORBIDDEN_PATTERNS_IN_CODE_ERROR: 1006,

  /** コード中の必要な表現 */
  REQUIRED_PATTERNS_IN_CODE_ERROR: 1007,

  /** ビルドエラー */
  BUILD_ERROR: 1100,

  /** ビルド時間制限超過 */
  BUILD_TIME_LIMIT_EXCEEDED: 1101,

  /** ビルドメモリ制限超過 */
  BUILD_MEMORY_LIMIT_EXCEEDED: 1102,

  /** ビルド時の出力サイズ制限超過 */
  BUILD_OUTPUT_SIZE_LIMIT_EXCEEDED: 1103,

  /** 必須ファイル不足 */
  MISSING_REQUIRED_SUBMISSION_FILE_ERROR: 1201,

  /** 必須出力ファイル不足 */
  MISSING_REQUIRED_OUTPUT_FILE_ERROR: 1202,

  /**
   * 受理
   *
   * 最大の値であり、降順で取得したときに最初に見つかることが保証されている。
   */
  ACCEPTED: 2000,
} as const;

export type DecisionCode = (typeof DecisionCode)[keyof typeof DecisionCode];
