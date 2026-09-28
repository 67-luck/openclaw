import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { redactSupportDiagnosticLine } from "../logging/diagnostic-support-redaction.js";

const MAX_EXCEPTIONS = 32;
const MAX_FRAMES = 16;
const MAX_LINE = 16 * 1024;
const MAX_MESSAGE = 512;
const MAX_LABEL = 128;
const MAX_OUTPUT_BYTES = 128 * 1024;

type OwnedExceptionFrame = {
  module: string;
  line: number;
  column?: number;
  functionName?: string;
};

type ObservedException = {
  message?: string;
  frames: OwnedExceptionFrame[];
  partial: boolean;
  messageTruncated?: true;
};

export type InstalledExceptionObservation = {
  exceptions: ObservedException[];
  observedExceptions: number;
  droppedExceptions: number;
  partialExceptions: number;
  droppedFrames: number;
  excludedFrames: number;
  droppedLines: number;
  truncatedMessages: number;
  redactionFailures: number;
  outputTruncated: boolean;
};

function safeLabel(value: string): boolean {
  return value.length <= MAX_LABEL && /^[A-Za-z_$][A-Za-z0-9_.$ -]*$/u.test(value);
}

function readMessage(line: string): string | undefined {
  const match =
    /^\s+(?:0x[\da-f]+|[\da-f]{16}): \[String\][^\r\n]*?: #message: (?:0x[\da-f]+|[\da-f]{16}) <String\[(\d+)\]: (.*)> \((?:const )?data field \d+,/iu.exec(
      line,
    );
  if (!match) {
    return undefined;
  }
  const rendered = match[2]!;
  let message: unknown;
  const plain = /^(?:u)?#(.*)$/u.exec(rendered);
  if (plain) {
    message = plain[1];
  } else {
    // V8 prefixes non-internalized strings with representation markers.
    const quoted = /^[ucst]*(".*")$/u.exec(rendered);
    if (quoted) {
      try {
        message = JSON.parse(quoted[1]!);
      } catch {
        return undefined;
      }
    }
  }
  // V8 can abbreviate a String's contents. A fragment is never safe redactor input.
  return typeof message === "string" && message.length === Number(match[1]) ? message : undefined;
}

function projectMessage(message: string, installRoot: string, windows: boolean): string {
  const withoutPointers = message.replace(/\b0x[\da-f]+\b/giu, "[pointer]");
  // Native Windows rendering can omit 0x; ambiguous IDs are withheld too.
  const opaque = windows
    ? withoutPointers.replace(/\b[\da-f]{16}\b/giu, "[redacted-hex]")
    : withoutPointers;
  return redactSupportDiagnosticLine(
    opaque,
    { env: {}, stateDir: installRoot },
    Number.MAX_SAFE_INTEGER,
  );
}

/** Private V8 output is consumed once; only this bounded projection may be retained. */
export function createInstalledExceptionObserver({ installRoot }: { installRoot: string }) {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/u.test(installRoot);
  const paths = windows ? path.win32 : path.posix;
  if (!paths.isAbsolute(installRoot)) {
    throw new Error("Exception observation requires an absolute installation root");
  }
  const root = paths.normalize(installRoot);
  const decoder = new StringDecoder("utf8");
  const result: InstalledExceptionObservation = {
    exceptions: [],
    observedExceptions: 0,
    droppedExceptions: 0,
    partialExceptions: 0,
    droppedFrames: 0,
    excludedFrames: 0,
    droppedLines: 0,
    truncatedMessages: 0,
    redactionFailures: 0,
    outputTruncated: false,
  };
  let current: ObservedException | undefined;
  let inProperties = false;
  let inStack = false;
  let pendingLine = "";
  let discardingLine = false;
  let finished = false;

  const complete = (terminated: boolean) => {
    if (!current) {
      return;
    }
    current.partial ||= !terminated || current.message === undefined;
    if (current.partial) {
      result.partialExceptions++;
    }
    result.exceptions.push(current);
    if (result.exceptions.length > MAX_EXCEPTIONS) {
      result.exceptions.shift();
      result.droppedExceptions++;
    }
    current = undefined;
    inProperties = false;
    inStack = false;
  };

  const readFrame = (line: string): OwnedExceptionFrame | undefined => {
    const frame = /^\s*\d+: (.*?) \[(?:0x[\da-f]+|[\da-f]{16})\] \[([^\]\r\n]+)\](?:\s|$)/iu.exec(
      line,
    );
    const location = frame && /^(.*?):~?(\d+)(?::(\d+))?$/u.exec(frame[2]!);
    if (!frame || !location) {
      return undefined;
    }
    let filename = location[1]!;
    if (filename.startsWith("file:")) {
      try {
        filename = fileURLToPath(filename, { windows });
      } catch {
        return undefined;
      }
    }
    if (!paths.isAbsolute(filename)) {
      return undefined;
    }
    const relative = paths.relative(root, paths.normalize(filename));
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${paths.sep}`) ||
      paths.isAbsolute(relative)
    ) {
      return undefined;
    }
    const module = paths.basename(filename);
    const lineNumber = Number(location[2]);
    const column = location[3] === undefined ? undefined : Number(location[3]);
    if (
      module.length > MAX_LABEL ||
      !/^[A-Za-z0-9_.-]+$/u.test(module) ||
      !Number.isSafeInteger(lineNumber) ||
      lineNumber < 1 ||
      (column !== undefined && (!Number.isSafeInteger(column) || column < 1))
    ) {
      return undefined;
    }
    const label = frame[1]!.replace(/\(aka [^)]*\)$/u, "").trim();
    const functionName = label === "/* anonymous */" ? "anonymous" : label;
    return {
      module,
      line: lineNumber,
      ...(column === undefined ? {} : { column }),
      ...(safeLabel(functionName) ? { functionName } : {}),
    };
  };

  const readLine = (line: string) => {
    if (line === "Exception thrown:") {
      complete(false);
      result.observedExceptions++;
      current = { frames: [], partial: false };
      return;
    }
    if (!current) {
      return;
    }
    if (/^==== Details =+$/u.test(line)) {
      complete(true);
    } else if (/^==== JS stack trace =+$/u.test(line)) {
      inProperties = false;
      inStack = true;
    } else if (!inStack && line === " - All own properties (excluding elements): {") {
      inProperties = true;
    } else if (inProperties && line.trim() === "}") {
      inProperties = false;
    } else if (inProperties && line.includes("#message:")) {
      current.message = readMessage(line);
      current.partial ||= current.message === undefined;
    } else if (inStack && /^\s*\d+: /u.test(line)) {
      const frame = readFrame(line);
      if (!frame) {
        result.excludedFrames++;
      } else if (current.frames.length < MAX_FRAMES) {
        current.frames.push(frame);
      } else {
        current.partial = true;
        result.droppedFrames++;
      }
    }
  };

  const consume = (text: string) => {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const end = newline < 0 ? text.length : newline;
      if (!discardingLine) {
        if (pendingLine.length + end - offset > MAX_LINE) {
          pendingLine = "";
          discardingLine = true;
          result.droppedLines++;
          if (current) {
            current.partial = true;
          }
        } else {
          pendingLine += text.slice(offset, end);
        }
      }
      if (newline < 0) {
        return;
      }
      if (!discardingLine) {
        readLine(pendingLine.replace(/\r$/u, ""));
      }
      pendingLine = "";
      discardingLine = false;
      offset = newline + 1;
    }
  };

  return {
    write(chunk: Buffer): void {
      if (finished) {
        throw new Error("Exception observer is already finished");
      }
      for (let offset = 0; offset < chunk.length; offset += 4096) {
        consume(decoder.write(chunk.subarray(offset, offset + 4096)));
      }
    },
    finish(redact: (value: string) => string): InstalledExceptionObservation {
      if (finished) {
        throw new Error("Exception observer is already finished");
      }
      finished = true;
      consume(decoder.end());
      if (pendingLine && current) {
        current.partial = true;
        result.droppedLines++;
      }
      pendingLine = "";
      complete(false);
      for (const exception of result.exceptions) {
        const wasPartial = exception.partial;
        try {
          if (exception.message !== undefined) {
            const message = projectMessage(redact(exception.message), installRoot, windows);
            exception.message = message.slice(0, MAX_MESSAGE);
            if (message.length > MAX_MESSAGE) {
              exception.messageTruncated = true;
              result.truncatedMessages++;
            }
          }
          exception.frames = exception.frames.flatMap((frame) => {
            const module = redact(frame.module);
            if (module.length > MAX_LABEL || !/^[A-Za-z0-9_.-]+$/u.test(module)) {
              result.droppedFrames++;
              exception.partial = true;
              return [];
            }
            const functionName =
              frame.functionName === undefined ? undefined : redact(frame.functionName);
            return [
              {
                module,
                line: frame.line,
                ...(frame.column === undefined ? {} : { column: frame.column }),
                ...(functionName !== undefined && safeLabel(functionName) ? { functionName } : {}),
              },
            ];
          });
        } catch {
          delete exception.message;
          exception.frames = [];
          exception.partial = true;
          result.redactionFailures++;
        }
        if (!wasPartial && exception.partial) {
          result.partialExceptions++;
        }
      }
      result.outputTruncated =
        result.droppedExceptions > 0 ||
        result.droppedFrames > 0 ||
        result.droppedLines > 0 ||
        result.truncatedMessages > 0;
      while (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) {
        result.exceptions.shift();
        result.droppedExceptions++;
        result.outputTruncated = true;
      }
      return result;
    },
  };
}
