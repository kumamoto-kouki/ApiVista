/**
 * backend-analysis / frontend-analysis 両モジュールで共有する基本型。
 * 各 models.ts はここから re-export する。
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface SourceLocation {
  file: string;
  line: number;
}

export interface Warning {
  target: string;
  reason: string;
}
