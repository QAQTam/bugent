import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { MockTransport } from './transport/MockTransport';
import { ProtocolTransport } from './transport/ProtocolTransport';
import type { AgentTransport } from './transport/types';
import './tokens/tokens.css';
import './app.css';

/** 入口：
 *  - URL 带 ?token= → ProtocolTransport（连本进程 bridge；ws 地址可用 ?ws= 覆盖，vite dev 用）
 *  - 否则 → MockTransport（无后端完整演示，主 spec §9） */
function createTransport(): AgentTransport {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (token === null || token === '') return new MockTransport();
  const transport = new ProtocolTransport({
    url: params.get('ws') ?? `ws://${window.location.host}/ws`,
    token,
    client: 'webui',
  });
  transport.connect();
  return transport;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App transport={createTransport()} />
  </StrictMode>,
);
