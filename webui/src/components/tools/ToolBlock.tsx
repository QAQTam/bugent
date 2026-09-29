import { memo, useState } from 'react';
import { Check, ChevronDown, Loader2, X } from 'lucide-react';
import type { MessageVM, TextBlockVM, ThinkingBlockVM, ToolGroupVM, ToolVM } from '../../store/sessions';
import { Markdown } from '../markdown/Markdown';
import { zh } from '../../i18n/zh';

/** 消息/工具块渲染（主 spec §3.1、§4）。失败默认展开，成功默认折叠。 */

export const UserMessage = memo(function UserMessage({ text }: { text: string }) {
  return (
    <div className="msg-user">
      <div className="bubble">{text}</div>
    </div>
  );
});

export const AssistantMessage = memo(function AssistantMessage({ message }: { message: MessageVM }) {
  return (
    <div className="msg-assistant">
      {message.blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
});

function BlockView({ block }: { block: MessageVM['blocks'][number] }): React.ReactElement {
  if (block.kind === 'text') return <TextBlockView block={block} />;
  if (block.kind === 'thinking') return <ThinkingBlock block={block} />;
  if (block.kind === 'tool') {
    return (
      <div className="tool-group">
        <ToolLine tool={block} />
      </div>
    );
  }
  return <ToolGroupBlock group={block} />;
}

/** 文本块：流式时末尾极轻淡入；无光标（守则 §2.3）。 */
const TextBlockView = memo(function TextBlockView({ block }: { block: TextBlockVM }) {
  return (
    <div className={block.streaming ? 'text-stream' : undefined}>
      <Markdown text={block.text} />
    </div>
  );
});

/** 思考块：默认折叠，一行「思考中 / 已思考 N 秒」；无流光（守则 §2.3）。 */
function ThinkingBlock({ block }: { block: ThinkingBlockVM }) {
  const [open, setOpen] = useState(false);
  const seconds = Math.max(1, Math.round(block.text.length / 40));
  return (
    <div className="thinking">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronDown size={13} data-open={open} style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
        <span>{block.streaming ? zh.thinkingRunning : zh.thinkingDone(seconds)}</span>
      </button>
      {open && <div className="body">{block.text}</div>}
    </div>
  );
}

/** 工具分组（§4.2）：折叠时一行摘要；运行中显示当前工具。 */
function ToolGroupBlock({ group }: { group: ToolGroupVM }) {
  const [open, setOpen] = useState(false);
  const running = group.items.some((t) => t.status === 'running' || t.status === 'pending');
  const done = group.items.every((t) => t.status === 'success' || t.status === 'error');
  const current = group.items.find((t) => t.status === 'running') ?? group.items[group.items.length - 1]!;
  const failed = group.items.some((t) => t.status === 'error');
  const summary = running ? zh.groupRunning(toolSummary(current)) : zh.groupDone(group.items.length);
  const bodyOpen = open || (!done && running);
  return (
    <div className="tool-group">
      <button className="tool-line" data-open={bodyOpen} onClick={() => setOpen(!open)} aria-expanded={bodyOpen}>
        <StatusIcon status={running ? 'running' : failed ? 'error' : 'success'} />
        <span className="summary">{summary}</span>
        {!done && <span className="duration">{`${group.items.filter((t) => t.status === 'success' || t.status === 'error').length}/${group.items.length}`}</span>}
        <ChevronDown size={14} className="chevron" data-open={bodyOpen} />
      </button>
      <div className="tool-body" data-open={bodyOpen}>
        <div>
          {group.items.map((t) => (
            <ToolLine key={t.id} tool={t} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** 单个工具行（§4.1）：状态图标 + 人话摘要 + 耗时；展开显示输入/输出。 */
function ToolLine({ tool }: { tool: ToolVM }) {
  const [open, setOpen] = useState(tool.open ?? false);
  const isOpen = open || (tool.status === 'error' && tool.open !== false);
  const duration = tool.durationMs !== undefined && tool.durationMs > 0 ? formatDuration(tool.durationMs) : null;
  const output = tool.output ?? '';
  const truncated = output.length > 10_000;
  return (
    <div className="tool-item">
      <button className="tool-line" onClick={() => setOpen(!open)} aria-expanded={isOpen}>
        <StatusIcon status={tool.status} />
        <span className="summary">{toolSummary(tool)}</span>
        {duration !== null && <span className="duration">{duration}</span>}
        <ChevronDown size={14} className="chevron" data-open={isOpen} />
      </button>
      <div className="tool-body" data-open={isOpen}>
        <div>
          <pre>{JSON.stringify(tool.input, null, 2)}</pre>
          {output !== '' && <pre>{truncated ? `${output.slice(0, 10_000)}…` : output}</pre>}
          {truncated && <CopyFullButton text={output} />}
        </div>
      </div>
      {tool.permission !== undefined && <PermissionCard tool={tool} />}
    </div>
  );
}

function CopyFullButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="tool-expand-more"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? zh.copied : zh.copyFull}
    </button>
  );
}

/** 权限卡（§4.4）：允许/拒绝/总是允许；"总是允许"仅协议 permission.request 提供。 */
function PermissionCard({ tool }: { tool: ToolVM }) {
  const perm = tool.permission!;
  const decide = (decision: 'allow' | 'deny' | 'always') => {
    window.dispatchEvent(new CustomEvent('webui:approve', { detail: { toolId: tool.id, decision } }));
  };
  return (
    <div className="perm-card" role="alertdialog" aria-label={perm.description}>
      <div>{perm.description}</div>
      <div className="actions">
        <button className="btn btn-primary" onClick={() => decide('allow')}>{zh.permAllow}</button>
        <button className="btn" onClick={() => decide('deny')}>{zh.permDeny}</button>
        {perm.allowAlways && (
          <button className="btn" onClick={() => decide('always')}>{zh.permAlways}</button>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: ToolVM['status'] | 'success' }) {
  if (status === 'running') return <span className="icon" data-status="running"><Loader2 size={14} className="spin" /></span>;
  if (status === 'pending') return <span className="icon" data-status="pending"><Loader2 size={14} className="spin" /></span>;
  if (status === 'error') return <span className="icon" data-status="error"><X size={14} /></span>;
  return <span className="icon"><Check size={14} /></span>;
}

/** 工具摘要：动词 + 对象（守则 §四.3）。识别常见入参字段，否则 JSON 前 40 字。 */
export function toolSummary(tool: ToolVM): string {
  const input = tool.input as Record<string, unknown> | null;
  if (input && typeof input === 'object') {
    const cmd = input.command;
    if (typeof cmd === 'string') return `运行 ${firstLine(cmd, 40)}`;
    const path = input.path ?? input.file_path ?? input.filePath;
    if (typeof path === 'string') {
      return tool.name === 'write_file' || tool.name === 'edit_file' || tool.name === 'apply_patch'
        ? `修改 ${path}`
        : `读取 ${path}`;
    }
    const query = input.query ?? input.pattern;
    if (typeof query === 'string') return `搜索 ${JSON.stringify(query)}`;
  }
  const json = JSON.stringify(tool.input) ?? '';
  return `${tool.name} ${json.slice(0, 40)}`.trim();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
