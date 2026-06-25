/**
 * sourceJump（design.md「sourceJump」, Requirements 5.1, 5.2）の単体テスト。
 *
 * `sourceJump.ts` は `vscode.workspace.workspaceFolders`/`vscode.window.showTextDocument`/
 * `vscode.Uri.joinPath`/`vscode.Selection`/`vscode.Range`/`vscode.Position` を実行時に参照するため、
 * 実VSCodeホスト外で動くvitestではこのモジュールは解決できない。`vi.mock("vscode", ...)`で
 * これらをテストごとに差し替え可能なフェイクに置き換える。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `Uri`の最小フェイク（`fsPath`比較・`joinPath`呼び出し引数検証にのみ使用）。 */
interface FakeUri {
  fsPath: string;
}

interface FakeWorkspaceFolder {
  uri: FakeUri;
  name: string;
  index: number;
}

interface FakePosition {
  line: number;
  character: number;
}

interface FakeRange {
  start: FakePosition;
  end: FakePosition;
}

interface FakeSelection extends FakeRange {
  anchor: FakePosition;
  active: FakePosition;
}

interface FakeTextEditor {
  selection: FakeSelection | undefined;
  revealRange: ReturnType<typeof vi.fn>;
}

let workspaceFolders: FakeWorkspaceFolder[] | undefined;
const joinPathMock = vi.fn();
const showTextDocumentMock = vi.fn();

vi.mock("vscode", () => {
  return {
    workspace: {
      get workspaceFolders() {
        return workspaceFolders;
      },
    },
    window: {
      showTextDocument: showTextDocumentMock,
    },
    Uri: {
      joinPath: joinPathMock,
    },
    Position: class {
      constructor(
        public readonly line: number,
        public readonly character: number,
      ) {}
    },
    Range: class {
      constructor(
        public readonly start: FakePosition,
        public readonly end: FakePosition,
      ) {}
    },
    Selection: class {
      public readonly start: FakePosition;
      public readonly end: FakePosition;
      constructor(
        public readonly anchor: FakePosition,
        public readonly active: FakePosition,
      ) {
        this.start = anchor;
        this.end = active;
      }
    },
  };
});

function makeFolder(fsPath: string, index = 0): FakeWorkspaceFolder {
  return { uri: { fsPath }, name: fsPath, index };
}

function makeEditor(): FakeTextEditor {
  return {
    selection: undefined,
    revealRange: vi.fn(),
  };
}

const WORKSPACE_ROOT = "/workspace/root";

describe("sourceJump.reveal", () => {
  beforeEach(() => {
    workspaceFolders = [makeFolder(WORKSPACE_ROOT)];
    // 実 vscode.Uri.joinPath は可変長（base, ...segments）。frontend/backend プレフィックス候補を
    // 正しく再現するため全セグメントを結合する。
    joinPathMock.mockReset().mockImplementation((folderUri: FakeUri, ...segments: string[]) => ({
      fsPath: [folderUri.fsPath, ...segments].join("/"),
    }));
    showTextDocumentMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("workspace相対パスをvscode.Uri.joinPathで絶対URIへ変換し、showTextDocumentへ渡す", async () => {
    const editor = makeEditor();
    showTextDocumentMock.mockResolvedValue(editor);

    const { reveal } = await import("../sourceJump.js");

    await reveal({ file: "backend/app/main.py", line: 1 });

    expect(joinPathMock).toHaveBeenCalledWith({ fsPath: WORKSPACE_ROOT }, "backend/app/main.py");
    expect(showTextDocumentMock).toHaveBeenCalledWith({
      fsPath: `${WORKSPACE_ROOT}/backend/app/main.py`,
    });
  });

  it("開いたエディタのselectionを0基底の該当行(line=10→index9)に折りたたんで設定する", async () => {
    const editor = makeEditor();
    showTextDocumentMock.mockResolvedValue(editor);

    const { reveal } = await import("../sourceJump.js");

    await reveal({ file: "backend/app/main.py", line: 10 });

    expect(editor.selection).toBeDefined();
    expect(editor.selection?.anchor).toEqual({ line: 9, character: 0 });
    expect(editor.selection?.active).toEqual({ line: 9, character: 0 });
  });

  it("editor.revealRangeを正しい位置のRangeで呼び出す", async () => {
    const editor = makeEditor();
    showTextDocumentMock.mockResolvedValue(editor);

    const { reveal } = await import("../sourceJump.js");

    await reveal({ file: "backend/app/main.py", line: 10 });

    expect(editor.revealRange).toHaveBeenCalledTimes(1);
    const rangeArg = editor.revealRange.mock.calls[0][0] as FakeRange;
    expect(rangeArg.start).toEqual({ line: 9, character: 0 });
    expect(rangeArg.end).toEqual({ line: 9, character: 0 });
  });

  it("showTextDocumentがrejectした場合、revealの戻り値のPromiseもrejectする(握り潰さない)", async () => {
    const originalError = new Error("file not found");
    showTextDocumentMock.mockRejectedValue(originalError);

    const { reveal } = await import("../sourceJump.js");

    // 複数候補すべてが失敗した場合、ファイルパスと行番号を含むエラーをthrowする（握り潰さない）
    await expect(reveal({ file: "backend/missing.py", line: 1 })).rejects.toThrow(
      "backend/missing.py:1 を開けませんでした",
    );
  });

  it("ワークスペースフォルダが開かれていない場合(undefined)、showTextDocumentを呼ばずにエラーをthrowする", async () => {
    workspaceFolders = undefined;

    const { reveal } = await import("../sourceJump.js");

    await expect(reveal({ file: "backend/app/main.py", line: 1 })).rejects.toThrow();
    expect(showTextDocumentMock).not.toHaveBeenCalled();
  });

  it("ワークスペースフォルダが0件の場合、showTextDocumentを呼ばずにエラーをthrowする", async () => {
    workspaceFolders = [];

    const { reveal } = await import("../sourceJump.js");

    await expect(reveal({ file: "backend/app/main.py", line: 1 })).rejects.toThrow();
    expect(showTextDocumentMock).not.toHaveBeenCalled();
  });

  it("ワークスペース外へ脱出する相対パス(../)は開かずに拒否する(パストラバーサル防御)", async () => {
    // 信頼できない location.file。joinPath は .. を正規化するため候補はワークスペース外を指す。
    const { reveal } = await import("../sourceJump.js");

    await expect(reveal({ file: "../../etc/passwd", line: 1 })).rejects.toThrow(
      "../../etc/passwd:1 を開けませんでした",
    );
    expect(showTextDocumentMock).not.toHaveBeenCalled();
  });

  it("途中で親ディレクトリへ脱出するパス(foo/../../../...)も拒否する", async () => {
    // frontend/・backend/ プレフィックスを付けた候補でもルート外へ抜ける深さ。
    const { reveal } = await import("../sourceJump.js");

    await expect(reveal({ file: "foo/../../../secret.txt", line: 1 })).rejects.toThrow(
      "foo/../../../secret.txt:1 を開けませんでした",
    );
    expect(showTextDocumentMock).not.toHaveBeenCalled();
  });
});
