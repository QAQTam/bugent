/**
 * 授权窗口 —— 所有"需要用户点头"的入口共用的一条时限。
 *
 * 为什么要有：三个入口（`ask` 规则、越界按次授权、能力授权）此前都直接
 * `await` 用户输入，**没有上限**。无人值守时（CI、后台、用户走开）模型会
 * 永远挂在那里，既不前进也不失败。
 *
 * 三条硬规则：
 *   1. **超时 = 拒绝**（fail closed）。替用户做决定的方向永远是"不"。
 *   2. **三态，不是 boolean。** 模型必须能区分"用户拒绝了"和"没人应答" ——
 *      前者该换个做法，后者该停下来问人。
 *   3. **不改档位。** 窗口只回答"这一次"，档位变更只能由用户主动触发。
 */

/** 授权窗口长度。改这个数字等于改产品语义，别在调用点随手覆盖。 */
export const AUTHORIZATION_TIMEOUT_MS = 60_000;

/**
 * 测试覆盖：`BUGENT_AUTHORIZATION_TIMEOUT_MS`。
 *
 * 生产路径不读它：60 秒是产品语义，不该被环境变量悄悄改掉。
 * 但 PTY / bridge 用例必须验证"到点自动拒绝"，等满一分钟不现实。
 */
export function authorizationTimeoutFromEnv(): number | undefined {
  const raw = Number(Bun.env.BUGENT_AUTHORIZATION_TIMEOUT_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

/** 一次授权请求的结论。 */
export type AuthorizationOutcome = "approved" | "denied" | "timeout";

/** 未获批准的那两种结论。回传模型时只可能是这两种之一。 */
export type AuthorizationRefusal = Exclude<AuthorizationOutcome, "approved">;

/** 回传模型的两种否定结论。前缀是稳定契约，测试与提示文案都按它比对。 */
export const AUTHORIZATION_DENIED = "用户拒绝操作";
export const AUTHORIZATION_TIMED_OUT = "授权已超时";

export function isApproved(outcome: AuthorizationOutcome): boolean {
  return outcome === "approved";
}

/** 倒计时文案。 */
export function formatCountdown(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `还剩 ${seconds}s`;
}

/**
 * 否定结论的解释，拼进回传模型的文案。
 *
 * 批准时返回 undefined —— 批准不需要解释。
 *
 * 超时文案**不带秒数**：窗口长度由实现方决定（TUI/CLI 可覆盖），闸门不知道
 * 具体是多少，写死一个数字迟早会和真实配置对不上。
 */
export function describeOutcome(outcome: AuthorizationOutcome): string | undefined {
  if (outcome === "denied") return AUTHORIZATION_DENIED;
  if (outcome === "timeout") return `${AUTHORIZATION_TIMED_OUT}（授权窗口内未收到确认）`;
  return undefined;
}

export interface AuthorizationWindowOptions {
  /**
   * 请求用户批准。返回 true 表示批准。
   *
   * `signal` 在窗口到点时 abort —— 实现方应当据此关掉自己的输入通道
   * （TUI 关弹窗、CLI 关 readline），否则那句提问会一直挂在终端上。
   */
  request: (signal: AbortSignal) => Promise<boolean>;
  timeoutMs?: number;
  /** 每秒回调一次剩余毫秒，供弹窗画倒计时。立即先回调一次。 */
  onTick?: (remainingMs: number) => void;
  /** 时钟注入，只为测试。 */
  now?: () => number;
}

/**
 * 在时限内等一次用户答复。
 *
 * 到点后 `request` 的 promise 取消不了（JS 里没法取消），所以这里是
 * **先到先得**：窗口只结算一次，后到的结果被丢弃。反过来，`request` 抛出
 * 异常时窗口把它原样抛给调用方 —— 静默转成"拒绝"会把 bug 伪装成用户行为。
 */
export async function withAuthorizationWindow(
  options: AuthorizationWindowOptions,
): Promise<AuthorizationOutcome> {
  const timeoutMs = options.timeoutMs ?? AUTHORIZATION_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const controller = new AbortController();

  let settle!: (outcome: AuthorizationOutcome) => void;
  let fail!: (error: unknown) => void;
  const settled = new Promise<AuthorizationOutcome>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  let done = false;

  // 计时器必须在 finish 之前声明好：deadline 一到就要能清掉 ticker。
  const ticker = setInterval(() => {
    options.onTick?.(Math.max(0, deadline - now()));
  }, 1000);
  // 倒计时是纯 UI，不该拖住进程退出；窗口本身仍然靠 deadline 计时器撑着。
  ticker.unref?.();

  const finish = (outcome: AuthorizationOutcome): void => {
    if (done) return;
    done = true;
    clearTimeout(deadlineTimer);
    clearInterval(ticker);
    settle(outcome);
  };

  const deadlineTimer = setTimeout(() => {
    controller.abort();
    finish("timeout");
  }, timeoutMs);

  const deadline = now() + timeoutMs;
  options.onTick?.(timeoutMs);

  // 用 async IIFE 包住：`options.request` 若**同步**抛出（比如实现方在构造
  // readline 时就炸了），异常也会走进 catch 完成清理 —— 直接 .then().catch()
  // 挂不上链，deadline/ticker 会泄漏整整一个窗口期（BUG-024）。
  void (async () => {
    try {
      const approved = await options.request(controller.signal);
      finish(approved ? "approved" : "denied");
    } catch (error) {
      if (done) return; // 窗口已按超时收口；这句拒绝是关输入通道的正常后果
      done = true;
      clearTimeout(deadlineTimer);
      clearInterval(ticker);
      fail(error);
    }
  })();

  return settled;
}
