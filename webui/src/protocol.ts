/**
 * 协议类型接线 —— 唯一来源是后端的 src/protocol/types.ts（vite alias `@protocol`）。
 * 只做类型 re-export：结构绝不复制，避免前后端漂移（spec §1/§5）。
 */
export type * from "@protocol";
export { UI_PROTOCOL_VERSION } from "@protocol";
