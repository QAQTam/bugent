/**
 * 命中区模型（hit-region model）。
 *
 * 一帧内"屏幕上哪里可以点、点了算谁"的全部知识都在这一个类里：
 *
 *   - `update(spec)`：compose 每帧把可点矩形登记进来，**顺序即优先级**；
 *   - `hitTargetAt` / `buttonTargetAt` / `buttonState`：纯查询，不改状态；
 *   - `processButtonMouse`：按钮的悬停/按下/抬起状态机（拖出按钮松手不触发）；
 *   - `collectHitProbes` / `collectVisualAnchors` / `verify`：命中自检
 *     （`BUGENT_HIT_PROBE=1` 打开，`=strict` 抛错）。
 *
 * 宿主（TuiApp）只负责两件事：每帧喂 spec（矩形从渲染来），以及在
 * invoke 回调里给按钮语义。判定路径只有一条 —— 鼠标处理与自检共用，
 * 自检若另写一份判定，就只是在测试另一份实现。
 */

import { hitRect, rectCenter, type HitRect } from "./core/hit.ts";
import {
  hitTargetName,
  messageRegions,
  type HitRegionEntry,
  type HitTarget,
  type ProbeButton,
} from "./hit-target.ts";
import {
  checkHitProbes,
  checkVisualAnchors,
  formatAnchorFailures,
  formatHitProbeFailures,
  type HitProbe,
  type VisualAnchor,
} from "./core/hit-probe.ts";
import { scrollbarRect, type ScrollbarMetrics } from "./core/scrollbar.ts";
import {
  inputCursorFromClick,
  type InputBoxRect,
} from "./widgets/input-box.ts";
import type { InputLayout } from "./widgets/input-view.ts";
import type { MessageAction } from "./widgets/message-actions.ts";
import type { MsgId } from "../core/message.ts";

/** 画在正文/思考区里的按钮：命中矩形 + 左上角字形（自检锚点用它比对画面）。 */
export interface PlacedButton {
  rect: HitRect;
  glyph: string;
}

/**
 * 当前鼠标悬停 / 按下的按钮。
 *
 * 所有矩形按钮都在这里 —— 悬停高亮只需要"重绘时按目标查一次状态"，
 * 各渲染点不必各存一份 hover 布尔值。
 */
export type ButtonTarget =
  | { kind: "dialog"; value: boolean }
  | { kind: "message"; value: MessageAction }
  | { kind: "moreHistory" }
  | { kind: "returnToLatest" }
  | { kind: "todoToggle" }
  /** 设置面板的一行：悬停/按下高亮与点击激活都按行号走。 */
  | { kind: "settingsRow"; index: number };

/** 按钮的稳定身份；比较悬停/按下目标时只认它。 */
export function buttonKey(target: ButtonTarget | undefined): string | undefined {
  switch (target?.kind) {
    case undefined:
      return undefined;
    case "dialog":
      return `dialog:${String(target.value)}`;
    case "message":
      return `message:${target.value}`;
    case "moreHistory":
      return "moreHistory";
    case "returnToLatest":
      return "returnToLatest";
    case "todoToggle":
      return "todoToggle";
    case "settingsRow":
      return `settings:${target.index}`;
  }
}

/**
 * 命中区间自检开关（`BUGENT_HIT_PROBE`）。
 *
 *   off（默认）  不跑
 *   1            每帧自检，发现点不到的区域就写 stderr（前缀 `[hit-probe]`）
 *   strict       额外直接抛错，fail fast
 *
 * 默认关闭：它是开发期工具，价值在测试与排查，不在线上。
 */
const hitProbeMode = ((): "off" | "on" | "strict" => {
  const raw = process.env.BUGENT_HIT_PROBE;
  if (raw === "strict") return "strict";
  return raw === undefined || raw === "" || raw === "0" ? "off" : "on";
})();

/** compose 每帧产出的可点矩形快照；全部字段由渲染层写入。 */
export interface HitFrameSpec {
  scrollbar: ScrollbarMetrics | undefined;
  /** 吸顶的本轮用户消息（右键开消息菜单）。 */
  pinnedUserHit: { msgid: MsgId; undoMsgid: MsgId; rect: HitRect } | undefined;
  messageButtonHits: readonly { value: MessageAction; rect: HitRect; glyph: string }[];
  dialogButtonHits: readonly { value: boolean; rect: HitRect; glyph: string }[];
  askLineHits: readonly { value: number; rect: HitRect }[];
  settingsRowHits: readonly { value: number; rect: HitRect }[];
  /** 弹窗整体矩形：范围内、按钮之外的点击被吞掉，不穿透到下面的消息列表。 */
  dialogRect: HitRect | undefined;
  /** 本帧是否有覆盖层（弹窗 / 消息菜单 / ask_user）。它盖住的区域不可点。 */
  overlayOpen: boolean;
  returnToLatestButton: PlacedButton | undefined;
  moreHistoryButton: PlacedButton | undefined;
  todoToggleButton: PlacedButton | undefined;
  /** 历史抽屉打开时"查看更多"按钮不登记。 */
  historyOpen: boolean;
  toolHits: readonly { callId: string; rect: HitRect }[];
  messageHits: readonly { msgid: MsgId; undoMsgid: MsgId; rect: HitRect }[];
  reasoningHits: readonly { id: string; rect: HitRect }[];
  /** 输入框：唯一要按列算字符索引的区域，单独参与判定。 */
  inputBox: { rect: InputBoxRect; layout: InputLayout } | undefined;
}

/**
 * 按钮交互状态机的处理结果；宿主据此决定同步高亮、重绘与是否继续分发：
 *
 *   "none"     什么都没变 —— 事件继续走通用命中分发（输入框点击等）；
 *   "cleared"  按下点在按钮外，清掉了上一帧残留的按下态 —— 同步 + 重绘后仍继续分发；
 *   "changed"  悬停/按下态变化 —— 事件被按钮层消费，不再分发；
 *   "invoked"  抬起命中，按钮语义已通过 invoke 执行 —— 事件被消费。
 */
export type ButtonMouseResult = "none" | "cleared" | "changed" | "invoked";

export class HitRegionModel {
  #spec: HitFrameSpec | undefined;
  #regions: HitRegionEntry[] = [];
  #hovered: ButtonTarget | undefined;
  #pressed: ButtonTarget | undefined;

  get hovered(): ButtonTarget | undefined {
    return this.#hovered;
  }

  get pressed(): ButtonTarget | undefined {
    return this.#pressed;
  }

  /** 登记本帧的可点区域。compose 每帧调用；查询在此之前会得到空结果。 */
  update(spec: HitFrameSpec): void {
    this.#spec = spec;
    this.#regions = this.#buildRegions(spec);
  }

  /** 组装一帧的可点区域，顺序即优先级。 */
  #buildRegions(spec: HitFrameSpec): HitRegionEntry[] {
    const regions: HitRegionEntry[] = [];

    if (spec.scrollbar !== undefined) {
      regions.push({
        target: { kind: "scrollbar" },
        rect: scrollbarRect(spec.scrollbar),
        button: "left",
      });
    }
    // 吸顶的本轮用户消息：它就是那条消息，所以右键行为与正文里的消息一致。
    if (spec.pinnedUserHit !== undefined) {
      regions.push({
        target: {
          kind: "message",
          msgid: spec.pinnedUserHit.msgid,
          undoMsgid: spec.pinnedUserHit.undoMsgid,
        },
        rect: spec.pinnedUserHit.rect,
        button: "right",
      });
    }
    for (const entry of spec.messageButtonHits) {
      regions.push({
        target: { kind: "messageButton", value: entry.value },
        rect: entry.rect,
        button: "left",
      });
    }
    for (const entry of spec.dialogButtonHits) {
      regions.push({
        target: { kind: "dialogButton", value: entry.value },
        rect: entry.rect,
        button: "left",
      });
    }
    for (const entry of spec.askLineHits) {
      regions.push({
        target: { kind: "askLine", line: entry.value },
        rect: entry.rect,
        button: "left",
      });
    }
    for (const entry of spec.settingsRowHits) {
      regions.push({
        target: { kind: "settingsRow", index: entry.value },
        rect: entry.rect,
        button: "left",
      });
    }
    if (spec.dialogRect !== undefined) {
      regions.push({ target: { kind: "dialogBody" }, rect: spec.dialogRect, button: "left" });
    }

    // 弹窗打开时它盖住的区域都不可点（鼠标处理在弹窗分支直接 return）
    if (spec.overlayOpen) return regions;

    if (spec.returnToLatestButton !== undefined) {
      regions.push({
        target: { kind: "returnToLatest" },
        rect: spec.returnToLatestButton.rect,
        button: "left",
      });
    }
    if (spec.moreHistoryButton !== undefined && !spec.historyOpen) {
      regions.push({
        target: { kind: "moreHistory" },
        rect: spec.moreHistoryButton.rect,
        button: "left",
      });
    }
    if (spec.todoToggleButton !== undefined) {
      regions.push({
        target: { kind: "todoToggle" },
        rect: spec.todoToggleButton.rect,
        button: "left",
      });
    }
    // 工具卡片、Thought 头部与普通消息的按键语义集中在 messageRegions
    // （纯函数，单测覆盖）。
    regions.push(...messageRegions(spec.toolHits, spec.messageHits, spec.reasoningHits));

    return regions;
  }

  /**
   * 屏幕坐标下面是什么 —— 纯查询，不改任何状态。
   *
   * 除了输入框，全部判定都是"点在不在这个屏幕矩形里"，优先级由 `#regions`
   * 的顺序表达 —— 没有第二种坐标换算，也就没有"两个空间对不上"这一类 bug。
   */
  hitTargetAt(x: number, y: number, button: ProbeButton = "left"): HitTarget | undefined {
    // 输入框要按列算出字符索引，是唯一需要额外换算的区域，单独处理。
    // 它和别的区域不重叠（弹窗打开时输入框矩形已清空），所以顺序无关。
    const inputBox = this.#spec?.inputBox;
    if (button === "left" && inputBox !== undefined) {
      const index = inputCursorFromClick(inputBox.rect, inputBox.layout, x, y);
      if (index !== undefined) return { kind: "input", index };
    }

    for (const region of this.#regions) {
      if (region.button !== button) continue;
      if (hitRect(region.rect, x, y)) return region.target;
    }
    return undefined;
  }

  /** 弹窗按钮的 hover / press 目标；其它区域不参与悬停高亮。 */
  buttonTargetAt(x: number, y: number): ButtonTarget | undefined {
    const target = this.hitTargetAt(x, y, "left");
    if (target === undefined) return undefined;
    switch (target.kind) {
      case "dialogButton":
        return { kind: "dialog", value: target.value };
      case "messageButton":
        return { kind: "message", value: target.value };
      case "moreHistory":
        return { kind: "moreHistory" };
      case "returnToLatest":
        return { kind: "returnToLatest" };
      case "todoToggle":
        return { kind: "todoToggle" };
      case "settingsRow":
        return { kind: "settingsRow", index: target.index };
      default:
        return undefined;
    }
  }

  sameTarget(a: ButtonTarget | undefined, b: ButtonTarget | undefined): boolean {
    return buttonKey(a) === buttonKey(b);
  }

  /** 某个按钮此刻是不是悬停 / 按下 —— 渲染时问这一句就够了。 */
  buttonState(target: ButtonTarget): { hovered?: boolean; pressed?: boolean } {
    const hovered = this.sameTarget(this.#hovered, target);
    const pressed = this.sameTarget(this.#pressed, target);
    return {
      ...(hovered ? { hovered: true } : {}),
      ...(pressed ? { pressed: true } : {}),
    };
  }

  /** 清空悬停/按下态（弹窗关闭、会话切换等失去上下文的时刻）。 */
  clear(): void {
    this.#hovered = undefined;
    this.#pressed = undefined;
  }

  /**
   * 按钮统一按下-抬起状态机：
   *
   *   - 移动：只更新悬停目标，不触发点击；
   *   - 按下：先显示按下态；
   *   - 抬起：还停在同一个按钮上才生效（`invoke`），拖到一半松手不误触发。
   *
   * 返回值决定宿主的收尾动作：
   *   "none"    什么都没变；
   *   "changed" 悬停/按下态变了，需要重绘；
   *   "invoked" 抬起命中，按钮语义已通过 invoke 执行。
   */
  processButtonMouse(
    x: number,
    y: number,
    pressed: boolean,
    motion: boolean,
    invoke: (target: ButtonTarget) => void,
  ): ButtonMouseResult {
    const target = this.buttonTargetAt(x, y);

    if (motion) {
      if (this.sameTarget(this.#hovered, target)) return "none";
      this.#hovered = target;
      return "changed";
    }

    if (pressed) {
      if (target !== undefined) {
        this.#pressed = target;
        return "changed";
      }
      // 按在按钮之外：清掉上一次残留的按下态（按住按钮拖出去就是这种）。
      // 状态变了要重绘，但事件本身不算被按钮消费 —— 点击可能落在输入框等
      // 需要通用分发的区域上。
      if (this.#pressed !== undefined) {
        this.#pressed = undefined;
        return "cleared";
      }
      return "none";
    }

    const pressedTarget = this.#pressed;
    if (pressedTarget === undefined) return "none";
    this.#pressed = undefined;
    if (this.sameTarget(pressedTarget, target)) {
      invoke(pressedTarget);
      return "invoked";
    }
    return "changed";
  }

  /**
   * 生成命中探针：每个可点区域取**自己矩形的中心**。
   *
   * 登记已经统一到屏幕坐标，所以这里不需要任何换算。被更靠前区域盖住的
   * 同键目标不可达，跳过。
   */
  collectHitProbes(): HitProbe[] {
    const probes: HitProbe[] = [];
    for (const [index, region] of this.#regions.entries()) {
      const center = rectCenter(region.rect);
      // 中心落在更靠前的区域里 = 被盖住（弹窗正文被 ask 行盖住就是这种情况），
      // 它本来就不该被要求可点。
      const shadowed = this.#regions
        .slice(0, index)
        .some(
          (earlier) =>
            earlier.button === region.button && hitRect(earlier.rect, center.x, center.y),
        );
      if (shadowed) continue;
      probes.push({
        name: hitTargetName(region.target),
        x: center.x,
        y: center.y,
        button: region.button,
      });
    }

    // 输入框不在区域表里（要按列算字符索引），单独补一条：点文本区首列应落在
    // 首行起点上。
    const inputBox = this.#spec?.inputBox;
    if (inputBox !== undefined) {
      probes.push({
        name: `input:${inputBox.layout.starts[inputBox.rect.startRow] ?? 0}`,
        x: inputBox.rect.textLeft,
        y: inputBox.rect.contentTop,
        button: "left",
      });
    }

    return probes;
  }

  /**
   * 视觉锚点：登记矩形的左上角应当正好是控件画出来的那个字形。
   *
   * 登记改用屏幕坐标之后，中心探针只能验证"命中路径与登记表一致"；登记表
   * 自己算错（比如居中留白算错）时两边会一起错、互相抵消。锚点直接比对渲染
   * 出来的字符，是唯一不受换算影响的参照物。
   */
  collectVisualAnchors(): VisualAnchor[] {
    const spec = this.#spec;
    if (spec === undefined) return [];
    const anchors: VisualAnchor[] = [];
    for (const entry of [...spec.messageButtonHits, ...spec.dialogButtonHits]) {
      anchors.push({ name: "button", x: entry.rect.left, y: entry.rect.top, glyph: entry.glyph });
    }
    for (const [name, button] of [
      ["moreHistory", spec.moreHistoryButton],
      ["returnToLatest", spec.returnToLatestButton],
      ["todoToggle", spec.todoToggleButton],
    ] as const) {
      if (button !== undefined) {
        anchors.push({ name, x: button.rect.left, y: button.rect.top, glyph: button.glyph });
      }
    }
    if (spec.dialogRect !== undefined) {
      anchors.push({
        name: "dialog",
        x: spec.dialogRect.left,
        y: spec.dialogRect.top,
        glyph: "┌",
      });
    }
    if (spec.inputBox !== undefined) {
      // 输入框框体从第 1 列开始，首行是 ┌───┐
      anchors.push({
        name: "input",
        x: 1,
        y: spec.inputBox.rect.top,
        glyph: "┌",
      });
    }
    return anchors;
  }

  /**
   * 自检：每个可点区域的中心，喂回命中入口必须命中它自己；登记的位置必须
   * 和画出来的位置重合。由 `BUGENT_HIT_PROBE` 打开，默认 no-op。
   */
  verify(lines: readonly string[], width: number, height: number): void {
    if (hitProbeMode === "off") return;
    // sliceAnsi 会把当前生效的样式一起带出来，比较字形前要先剥掉
    const cellAt = (x: number, y: number): string => {
      const line = lines[y - 1];
      return line === undefined ? "" : Bun.stripANSI(Bun.sliceAnsi(line, x - 1, x));
    };
    const reach = checkHitProbes(this.collectHitProbes(), (x, y, button) => {
      const target = this.hitTargetAt(x, y, button);
      return target === undefined ? undefined : hitTargetName(target);
    });
    const anchors = checkVisualAnchors(this.collectVisualAnchors(), cellAt);
    if (reach.length === 0 && anchors.length === 0) return;

    const message = [
      reach.length > 0 ? formatHitProbeFailures(reach, { width, height }) : "",
      anchors.length > 0 ? formatAnchorFailures(anchors, { width, height }) : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n");
    process.stderr.write(`[hit-probe] ${message}\n`);
    if (hitProbeMode === "strict") throw new Error(message);
  }
}
