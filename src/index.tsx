#!/usr/bin/env bun

import { createCliRenderer, RGBA, SyntaxStyle, TextAttributes, type TextChunk } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { ReactNode } from "react";
import { useState } from "react";

type RawAppConfig = {
  config?: {
    worktree_dir?: string,
    theme?: string
  };
};

type ParsedAppConfig = {
  worktreesDir: string;
};

type FocusTarget =
  | "worktreesDir"
  | "repositoryNamespace"
  | "slug"
  | "newBranch"
  | "createTmuxWindow"
  | "refBranch"
  | "command"
  | "execute";

type Status =
  | { type: "idle"; message: string }
  | { type: "info"; message: string }
  | { type: "success"; message: string }
  | { type: "error"; message: string };

const focusOrder: FocusTarget[] = [
  "worktreesDir",
  "repositoryNamespace",
  "slug",
  "newBranch",
  "createTmuxWindow",
  "refBranch",
  "command",
  "execute",
];

const fieldColors = {
  worktreesDir: "#f59e0b",
  repositoryNamespace: "#38bdf8",
  slug: "#c084fc",
  newBranch: "#51cf66",
  createTmuxWindow: "#2dd4bf",
  refBranch: "#f87171",
} as const;

const fieldRgba = {
  worktreesDir: RGBA.fromHex(fieldColors.worktreesDir),
  repositoryNamespace: RGBA.fromHex(fieldColors.repositoryNamespace),
  slug: RGBA.fromHex(fieldColors.slug),
  refBranch: RGBA.fromHex(fieldColors.refBranch),
} as const;

const commandSyntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: "#e5e7eb" },
  command: { fg: "#9ca3af" },
  function: { fg: "#9ca3af" },
  parameter: { fg: "#9ca3af" },
  operator: { fg: "#9ca3af" },
});

function parseConfigToml(contents: string): ParsedAppConfig {
  const parsed: RawAppConfig = Bun.TOML.parse(contents) ?? {};

  return {
    worktreesDir: parsed?.config?.['worktree_dir'] ?? ""
  }
}

async function loadConfig(): Promise<{ config: ParsedAppConfig; error?: string }> {
  const configPath = join(homedir(), ".config", "ezwt", "config.toml");

  try {
    const contents = await Bun.file(configPath).text();
    return { config: parseConfigToml(contents) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { config: { worktreesDir: "" } };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      config: { worktreesDir: "" },
      error: `Could not read ${configPath}: ${message}`,
    };
  }
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function worktreePath(worktreesDir: string, repositoryNamespace: string, slug: string): string {
  const name = `${repositoryNamespace}/${slug}`;
  return worktreesDir === "" ? name : `${worktreesDir.replace(/\/$/, "")}/${name}`;
}

type CommandInput = {
  worktreesDir: string;
  repositoryNamespace: string;
  slug: string;
  newBranch: boolean;
  refBranch: string;
};

type CommandInvocation = {
  program: string;
  args: string[];
};

function gitCommand(input: CommandInput): CommandInvocation {
  const path = worktreePath(input.worktreesDir, input.repositoryNamespace, input.slug);
  if (input.newBranch) {
    return { program: "git", args: ["worktree", "add", "-b", input.slug, path, input.refBranch] };
  }
  return { program: "git", args: ["worktree", "add", path, input.refBranch] };
}

function tmuxCommand(input: Pick<CommandInput, "worktreesDir" | "repositoryNamespace" | "slug">): CommandInvocation {
  return {
    program: "tmux",
    args: ["new-session", "-ds", `worktree/${input.repositoryNamespace}-${input.slug}`, "-c", worktreePath(input.worktreesDir, input.repositoryNamespace, input.slug)],
  };
}

function commandText(command: CommandInvocation): string {
  return [command.program, ...command.args].map(shellEscape).join(" ");
}

function displayedCommandText(input: CommandInput & { createTmuxWindow: boolean }): string {
  const lines = [commandText(gitCommand(input))];
  if (input.createTmuxWindow) lines.push(commandText(tmuxCommand(input)));
  return lines.join("\n");
}

function displayedShellCommand(input: CommandInput & { createTmuxWindow: boolean }): string {
  return displayedCommandText(input).split("\n").map((line) => `$ ${line}`).join("\n");
}

type CommandColorRange = {
  start: number;
  end: number;
  fg: RGBA;
};

function addRange(ranges: CommandColorRange[], command: string, value: string, fg: RGBA, fromIndex = 0): number {
  if (value === "") return fromIndex;
  const start = command.indexOf(value, fromIndex);
  if (start === -1) return fromIndex;
  const end = start + value.length;
  ranges.push({ start, end, fg });
  return end;
}

function commandColorRanges(input: CommandInput, command: string): CommandColorRange[] {
  const ranges: CommandColorRange[] = [];
  let cursor = 0;

  if (input.newBranch) {
    cursor = addRange(ranges, command, shellEscape(input.slug), fieldRgba.slug, cursor);
  }

  const path = shellEscape(worktreePath(input.worktreesDir, input.repositoryNamespace, input.slug));
  const pathStart = command.indexOf(path, cursor);
  if (pathStart !== -1) {
    const normalizedWorktreesDir = input.worktreesDir.replace(/\/$/, "");
    let pathCursor = pathStart;
    pathCursor = addRange(ranges, command, normalizedWorktreesDir, fieldRgba.worktreesDir, pathCursor);
    pathCursor = addRange(ranges, command, input.repositoryNamespace, fieldRgba.repositoryNamespace, pathCursor);
    addRange(ranges, command, input.slug, fieldRgba.slug, pathCursor);
    cursor = pathStart + path.length;
  }

  addRange(ranges, command, shellEscape(input.refBranch), fieldRgba.refBranch, cursor);
  return ranges.sort((first, second) => first.start - second.start);
}

function tmuxCommandColorRanges(input: CommandInput, command: string): CommandColorRange[] {
  const ranges = commandColorRanges(input, command);
  const path = shellEscape(worktreePath(input.worktreesDir, input.repositoryNamespace, input.slug));
  const firstPathEnd = command.indexOf(path) + path.length;
  const secondPathStart = command.indexOf(path, firstPathEnd);

  if (secondPathStart !== -1) {
    const normalizedWorktreesDir = input.worktreesDir.replace(/\/$/, "");
    let pathCursor = secondPathStart;
    pathCursor = addRange(ranges, command, normalizedWorktreesDir, fieldRgba.worktreesDir, pathCursor);
    pathCursor = addRange(ranges, command, input.repositoryNamespace, fieldRgba.repositoryNamespace, pathCursor);
    addRange(ranges, command, input.slug, fieldRgba.slug, pathCursor);
  }

  return ranges.sort((first, second) => first.start - second.start);
}

function colorCommandChunks(command: string, ranges: CommandColorRange[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (range.start > cursor) {
      chunks.push({ __isChunk: true, text: command.slice(cursor, range.start) });
    }

    if (range.end > range.start) {
      chunks.push({ __isChunk: true, text: command.slice(range.start, range.end), fg: range.fg });
    }

    cursor = Math.max(cursor, range.end);
  }

  if (cursor < command.length) {
    chunks.push({ __isChunk: true, text: command.slice(cursor) });
  }

  return chunks;
}

function isComplete(input: CommandInput): boolean {
  return (
    input.worktreesDir.trim() !== "" &&
    input.repositoryNamespace.trim() !== "" &&
    input.slug.trim() !== "" &&
    input.refBranch.trim() !== ""
  );
}

function FocusRow({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <box flexDirection="row" gap={1}>
      <box backgroundColor={active ? "white" : undefined} width={1} alignItems="center">
      </box>
      <box flexGrow={1}>{children}</box>
    </box>
  );
}

function FieldRow({
  active,
  compact,
  label,
  labelColor,
  children,
}: {
  active: boolean;
  compact: boolean;
  label: string;
  labelColor: string;
  children: ReactNode;
}) {
  return (
    <FocusRow active={active}>
      {compact ? (
        <box flexDirection="row" gap={1} alignItems="center">
          <box width={24}>
            <text fg={labelColor}>{label}</text>
          </box>
          <box flexGrow={1}>{children}</box>
        </box>
      ) : (
        <box flexDirection="column" gap={0}>
          <text fg={labelColor}>{label}</text>
          {children}
        </box>
      )}
    </FocusRow>
  );
}

function App({ config, initialStatus }: { config: ParsedAppConfig; initialStatus: Status }) {
  const renderer = useRenderer();
  const { height } = useTerminalDimensions();
  const [worktreesDir, setWorktreesDir] = useState(config.worktreesDir);
  const [repositoryNamespace, setRepositoryNamespace] = useState(basename(process.cwd()));
  const [slug, setSlug] = useState("");
  const [newBranch, setNewBranch] = useState(true);
  const [createTmuxWindow, setCreateTmuxWindow] = useState(false);
  const [refBranch, setRefBranch] = useState("main");
  const [focus, setFocus] = useState<FocusTarget>(() => config.worktreesDir.trim() === "" ? "worktreesDir" : "slug");
  const [status, setStatus] = useState<Status>(initialStatus);
  const [isRunning, setIsRunning] = useState(false);

  const input = { worktreesDir, repositoryNamespace, slug, newBranch, refBranch };
  const command = displayedCommandText({ ...input, createTmuxWindow });
  const displayedCommand = displayedShellCommand({ ...input, createTmuxWindow });
  const commandRanges = createTmuxWindow ? tmuxCommandColorRanges(input, displayedCommand) : commandColorRanges(input, displayedCommand);
  const complete = isComplete(input);
  const compact = height < 34;

  async function execute() {
    if (!complete || isRunning) {
      setStatus({ type: "error", message: "Fill worktree directory, repository namespace, slug, and ref branch first." });
      return;
    }

    setIsRunning(true);
    setStatus({ type: "info", message: "Creating worktree..." });

    try {
      const worktreeCommand = gitCommand(input);
      const proc = Bun.spawn([worktreeCommand.program, ...worktreeCommand.args], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      if (exitCode === 0) {
        if (createTmuxWindow) {
          const sessionCommand = tmuxCommand(input);
          const tmuxProc = Bun.spawn([sessionCommand.program, ...sessionCommand.args], {
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
          });
          const [tmuxExitCode, tmuxStderr] = await Promise.all([
            tmuxProc.exited,
            new Response(tmuxProc.stderr).text(),
          ]);

          if (tmuxExitCode !== 0) {
            setStatus({ type: "error", message: tmuxStderr.trim() || `Worktree created, but tmux exited with code ${tmuxExitCode}.` });
            return;
          }
        }

        setStatus({ type: "success", message: stdout.trim() || (createTmuxWindow ? "Worktree and tmux window created." : "Worktree created.") });
      } else {
        setStatus({ type: "error", message: stderr.trim() || `git exited with code ${exitCode}.` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ type: "error", message: `Could not run git worktree add: ${message}` });
    } finally {
      setIsRunning(false);
    }
  }

  function moveFocus(direction: 1 | -1) {
    setFocus((current) => {
      const currentIndex = focusOrder.indexOf(current);
      const nextIndex = (currentIndex + direction + focusOrder.length) % focusOrder.length;
      return focusOrder[nextIndex] ?? "worktreesDir";
    });
  }

  function copyCommand() {
    const copied = renderer.copyToClipboardOSC52(command);
    setStatus({
      type: copied ? "success" : "error",
      message: copied ? "Command copied to clipboard." : "Terminal does not support OSC52 clipboard copy.",
    });
  }

  useKeyboard((key) => {
    if (key.name === "escape") {
      renderer.destroy();
      return;
    }

    if (key.name === "tab") {
      moveFocus(key.shift ? -1 : 1);
      return;
    }

    if (key.name === "down") {
      moveFocus(1);
      return;
    }

    if (key.name === "up") {
      moveFocus(1);
      return;
    }

    if (key.name === "return" && key.ctrl) {
      void execute();
      return;
    }

    if (focus === "newBranch" && (key.name === "space" || key.name === "return")) {
      setNewBranch((value) => !value);
      return;
    }

    if (focus === "createTmuxWindow" && (key.name === "space" || key.name === "return")) {
      setCreateTmuxWindow((value) => !value);
      return;
    }

    if (focus === "command" && key.name === "c") {
      copyCommand();
      return;
    }

    if (focus === "execute" && key.name === "return") {
      void execute();
    }
  });

  const statusColor = status.type === "error" ? "#ff6b6b" : status.type === "success" ? "#51cf66" : "#9ca3af";
  const buttonColor = complete && !isRunning ? "#51cf66" : "#6b7280";

  return (
    <box flexGrow={1} flexDirection="column" padding={1} gap={1}>
      <box flexDirection="column" gap={1}>
        <text fg="#93c5fd" attributes={TextAttributes.BOLD}>ezwt</text>
        <text fg="#9ca3af">Tab/Shift+Tab moves focus. Ctrl+Enter executes. Esc exits.</text>
      </box>

      <FieldRow active={focus === "worktreesDir"} compact={compact} label="Worktree directory" labelColor={fieldColors.worktreesDir}>
        <box border focused={focus === "worktreesDir"} height={3}>
          <input value={worktreesDir} focused={focus === "worktreesDir"} onInput={setWorktreesDir} placeholder="/path/to/worktrees" />
        </box>
      </FieldRow>

      <FieldRow active={focus === "repositoryNamespace"} compact={compact} label="Repository namespace" labelColor={fieldColors.repositoryNamespace}>
        <box border focused={focus === "repositoryNamespace"} height={3}>
          <input value={repositoryNamespace} focused={focus === "repositoryNamespace"} onInput={setRepositoryNamespace} />
        </box>
      </FieldRow>

      <FieldRow active={focus === "slug"} compact={compact} label="Slug / branch name" labelColor={fieldColors.slug}>
        <box border focused={focus === "slug"} height={3}>
          <input value={slug} focused={focus === "slug"} onInput={setSlug} placeholder="feature-name" />
        </box>
      </FieldRow>

      <FocusRow active={focus === "newBranch"}>
        <box focused={focus === "newBranch"} height={1}>
          <text fg={fieldColors.newBranch}>
            {newBranch ? "[x]" : "[ ]"} New branch
          </text>
        </box>
      </FocusRow>

      <FocusRow active={focus === "createTmuxWindow"}>
        <box focused={focus === "createTmuxWindow"} height={1}>
          <text fg={fieldColors.createTmuxWindow}>
            {createTmuxWindow ? "[x]" : "[ ]"} Create a new tmux window
          </text>
        </box>
      </FocusRow>

      <FieldRow active={focus === "refBranch"} compact={compact} label="Ref branch" labelColor={fieldColors.refBranch}>
        <box border focused={focus === "refBranch"} height={3}>
          <input value={refBranch} focused={focus === "refBranch"} onInput={setRefBranch} />
        </box>
      </FieldRow>

      <FocusRow active={focus === "command"}>
        <box flexDirection="column" gap={0}>
          <text fg={focus === "command" ? "#93c5fd" : "#9ca3af"}>Command (press c to copy)</text>
          <box focused={focus === "command"} minHeight={compact ? 4 : 5} flexDirection="row" backgroundColor="#141521">
            <box width={1} backgroundColor="#050712" />
            <box flexGrow={1} padding={1} backgroundColor="#141521">
              <code
                content={displayedCommand}
                filetype="bash"
                syntaxStyle={commandSyntaxStyle}
                bg="#141521"
                onChunks={() => colorCommandChunks(displayedCommand, commandRanges)}
              />
            </box>
          </box>
        </box>
      </FocusRow>

      <FocusRow active={focus === "execute"}>
        <box border focused={focus === "execute"} height={3} justifyContent="center" alignItems="center">
          <text fg={buttonColor} attributes={TextAttributes.BOLD}>{isRunning ? "Creating..." : "Execute"}</text>
        </box>
      </FocusRow>

      <text fg={statusColor}>{status.message}</text>
    </box>
  );
}

const { config, error } = await loadConfig();
const renderer = await createCliRenderer();
createRoot(renderer).render(
  <App
    config={config}
    initialStatus={error ? { type: "error", message: error } : { type: "idle", message: "Ready." }}
  />,
);
