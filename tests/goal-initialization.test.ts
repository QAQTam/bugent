import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GOAL_INITIALIZATION_INSTRUCTION,
  GoalController,
} from "../src/goal/controller.ts";
import { runUserTurn } from "../src/core/loop.ts";
import { AgentSession } from "../src/core/session.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import { GoalRepository } from "../src/store/goal-repository.ts";
import { SessionStore } from "../src/store/repository.ts";
import { createGoalTools } from "../src/tools/goal.ts";
import { createTodoWriteTool } from "../src/tools/todo.ts";
import { ToolRegistry } from "../src/tools/types.ts";

const stores: SessionStore[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  stores.length = 0;
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("Goal initialization integration", () => {
  test("/goal 授权的一轮可完成 contract -> plan -> todo -> active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bugent-goal-init-"));
    dirs.push(dir);
    const store = new SessionStore({ path: join(dir, "bugent.db") });
    stores.push(store);
    store.createSession({
      id: "s1",
      createdAt: 1,
      updatedAt: 1,
      model: "test",
      systemPrompt: "SYS",
      cwd: process.cwd(),
    });
    const client = createMockClient({
      script: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "create_goal",
              args: {
                raw_intent: "实现 Goal",
                objective: "实现完整 Goal",
                success_criteria: ["测试通过"],
                constraints: ["不破坏旧消息"],
              },
            },
            {
              id: "c2",
              name: "update_plan",
              args: {
                phases: [
                  {
                    id: "p1",
                    title: "实现",
                    objective: "完成 Goal",
                    checkpoint_ids: ["cp1"],
                    verification: ["bun test"],
                  },
                ],
                checkpoints: [
                  {
                    id: "cp1",
                    order: 1,
                    title: "实现",
                    deliverable: "Goal runtime",
                    acceptance_criteria: ["测试通过"],
                    evidence_required: ["test"],
                  },
                ],
              },
            },
            {
              id: "c3",
              name: "todo_write",
              args: {
                checkpoint_id: "cp1",
                todos: [{ id: "t1", content: "开始实现", status: "in_progress" }],
              },
            },
          ],
        },
        { text: "Goal 已就绪" },
      ],
    });
    const session = new AgentSession({
      id: "s1",
      system: "SYS",
      client,
      model: "test",
      onMessage: (message) => store.appendMessage("s1", message),
    });
    const controller = new GoalController({
      repository: new GoalRepository(store.db),
      session,
      store,
      cwd: process.cwd(),
      handoffRoot: join(dir, "handoffs"),
    });
    const registry = new ToolRegistry();
    for (const tool of createGoalTools(controller)) registry.register(tool);
    registry.register(createTodoWriteTool({ goalController: controller }));

    controller.authorizeCreate();
    session.enqueueInjection(GOAL_INITIALIZATION_INSTRUCTION, "goal");
    const result = await runUserTurn(session, "实现 Goal", {
      tools: registry,
      cwd: process.cwd(),
    });

    expect(result.reason).toBe("stop");
    const goal = controller.currentGoal();
    expect(goal?.phase).toBe("executing");
    expect(goal?.activeCheckpointId).toBe("cp1");
    expect(controller.repository.latestPlanRevision(goal!.id)?.revision).toBe(1);
    expect(controller.repository.latestTodoSnapshot(goal!.id, "cp1")?.todos).toHaveLength(1);
    expect(session.messages.some((message) => message.injectionSource === "plan")).toBe(true);
    expect(session.messages.some((message) => message.injectionSource === "checkpoint")).toBe(true);
  });
});
