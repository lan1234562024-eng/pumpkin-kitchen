import { Profiler, useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { GameEvent, SeatId, SemanticAction, InteractionOperation } from '../shared/contracts';
import { RULESET_ID } from '../shared/ruleset';
import { STATION_IDS, RECIPES } from '../game/world';
import { approachFor } from '../game/navigation';
import { connectRoom, type Connection } from './connection';
import { createClientPerformance } from './performance';
import { createActionId } from './action-id';
import { createKeyboardControls, type KeyboardControls } from './keyboard-controls';
import { createMovementGate } from './movement-gate';
import { connectDemoRoom } from './demo-connection';
const IS_DEMO = import.meta.env.MODE === 'demo';
import { mountRoomGame, type RoomGame } from './game/RoomScene';
import { eventText, itemName, nearest, uiSnapshotKey, stationLabel } from './ui-snapshot';
export { itemName } from './ui-snapshot';
import './styles.css';
type Status = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
type SnapshotMessage = Extract<ServerMessage, {
    type: 'snapshot';
}>;
const errors: Record<string, string> = { RULESET_MISMATCH: '厨房版本不匹配，请更新页面和服务端。', TARGET_BLOCKED: '这里是柜台，请点旁边的地面。', NO_PATH: '暂时走不到那里。', STALE_STATE: '状态刚刚更新，请再操作一次。', STALE_GENERATION: '席位控制权已变化。', SEAT_BUSY: '正在忙碌，请先取消当前动作。', OUT_OF_RANGE: '再靠近一点工位。', INVALID_INTERACTION: '这里暂时不能放入或取出这个物品。', FORBIDDEN: '请先接管这个席位。', EXPIRED: '动作超时，请重试。', INPUT_OWNED: '另一处正在控制这个席位。' };
const operations: Record<InteractionOperation, string> = { take: '拿起', place: '放下', source: '取食材', chop: '放上砧板切配', resume_chop: '继续切配', add_ingredient: '加入食材', pour: '整份盛碗', take_plate: '取干净碗', return_plate: '退回空碗', accept_order: '接下一单', deliver: '交付成品', cleanup: '清理内容物', unavailable: '暂不可互动' };
export default function App() {
    const performanceRef = useRef<ReturnType<typeof createClientPerformance> | null>(null);
    return <Profiler id="kitchen" onRender={(_id, _phase, duration) => performanceRef.current?.reactRender(duration)}><KitchenApp performanceRef={performanceRef}/></Profiler>;
}
function KitchenApp({performanceRef}: {performanceRef: {current: ReturnType<typeof createClientPerformance> | null}}) {
    const [message, setMessage] = useState<SnapshotMessage>(), [status, setStatus] = useState<Status>('connecting'), [compatible, setCompatible] = useState(false), [selected, setSelected] = useState<SeatId>('human'), [feedback, setFeedback] = useState('一起准备南瓜小厨房吧。');
    const roomRef = useRef<HTMLDivElement>(null), gameRef = useRef<RoomGame | null>(null), connectionRef = useRef<Connection | null>(null), keyboardRef = useRef<KeyboardControls | null>(null), gateRef = useRef<ReturnType<typeof createMovementGate> | null>(null);
    const messageRef = useRef<SnapshotMessage | undefined>(undefined), statusRef = useRef<Status>('connecting'), compatibleRef = useRef(false), selectedRef = useRef<SeatId>('human');
    const sendMessage = useCallback((m: ClientMessage) => compatibleRef.current && (connectionRef.current?.send(m) ?? false), []);
    const sendNow = useCallback((action: SemanticAction, seatId = selectedRef.current): string | false => { const s = messageRef.current?.snapshot; if (!s || !compatibleRef.current || statusRef.current !== 'connected' || s.phase !== 'playing' || s.seats[seatId].controller !== 'human')
        return false; const id = createActionId(); const sent = sendMessage({ type: 'command', ruleset_id: RULESET_ID, command: { action_id: id, state_version: s.state_version, issued_at_ms: s.server_time_ms, ttl_ms: 10000, seat_generation: s.seats[seatId].generation, seat_id: seatId, action } }); setFeedback(sent ? '动作已发送…' : '连接中断，请重新操作。'); return sent ? id : false; }, [sendMessage]);
    const releaseThen = useCallback((callback: () => void) => { if (keyboardRef.current)
        keyboardRef.current.releaseThen(callback);
    else if (statusRef.current === 'connected')
        callback(); }, []);
    const requestMove = useCallback((action: Extract<SemanticAction, {
        type: 'move_to';
    }>, seat: SeatId) => releaseThen(() => gateRef.current?.request(seat, () => { sendNow(action, seat); })), [releaseThen, sendNow]);
    const intent = useCallback((action: SemanticAction, seat = selectedRef.current) => { if (action.type === 'move_to')
        requestMove(action, seat);
    else {
        gateRef.current?.reset();
        releaseThen(() => { sendNow(action, seat); });
    } }, [requestMove, releaseThen, sendNow]);
    const interact = useCallback(() => { const m = messageRef.current, seat = selectedRef.current, target = nearest(m?.snapshot, seat); if (!target)
        return; const preview = m?.interaction_previews[seat][target]; if (preview?.allowed)
        sendNow({ type: 'interact', target }, seat);
    else
        setFeedback(errors[preview?.error ?? ''] ?? '当前没有可执行的互动。'); }, [sendNow]);
    const result = useCallback((m: Exclude<ServerMessage, {
        type: 'snapshot';
    }>) => { if (m.type === 'human_input_result') {
        keyboardRef.current?.handleResult(m);
        return;
    } if (m.type === 'error') {
        setFeedback(errors[m.code] ?? m.message);
        if (m.code === 'RULESET_MISMATCH') {
            compatibleRef.current = false;
            setCompatible(false);
            gateRef.current?.reset();
            keyboardRef.current?.updateContext();
        }
        return;
    } gateRef.current?.receipt(m.receipt); setFeedback(m.receipt.status === 'accepted' ? '动作已确认。' : errors[m.receipt.error ?? ''] ?? '动作未通过，请重试。'); }, []);
    useEffect(() => {
        const gate = createMovementGate({ getContext: () => ({ snapshot: messageRef.current?.snapshot, connected: statusRef.current === 'connected' && compatibleRef.current, seat_id: selectedRef.current }), sendCancel: seat => sendNow({ type: 'cancel' }, seat) });
        gateRef.current = gate;
        const keyboard = createKeyboardControls({ getContext: () => { const s = messageRef.current?.snapshot, id = selectedRef.current, p = s?.seats[id]; return { connected: statusRef.current === 'connected', enabled: compatibleRef.current && s?.phase === 'playing' && p?.controller === 'human', seat_id: id, seat_generation: p?.generation ?? 0, round_id: s?.round_id ?? 0 }; }, send: sendMessage, onInteract: interact, beforeMove: resume => gate.request(selectedRef.current, resume, 'keyboard'), onRejected: m => setFeedback(errors[m.error ?? ''] ?? '请重新按键。') });
        keyboardRef.current = keyboard;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const diagnostics = createClientPerformance(report => { connectionRef.current?.send(report); });
        performanceRef.current = diagnostics;
        let lastUiKey: string | undefined;
        const connection = (IS_DEMO ? connectDemoRoom : connectRoom)(`${protocol}//${window.location.host}/game-ws`, m => { messageRef.current = m; if (!compatibleRef.current) { compatibleRef.current = true; setCompatible(true); } gameRef.current?.setSnapshot(m.snapshot); keyboard.updateContext(); gate.update(); const nextUiKey = uiSnapshotKey(m, selectedRef.current); if (nextUiKey !== lastUiKey) { lastUiKey = nextUiKey; setMessage(m); } }, result, { diagnostics, onStatus: s => { statusRef.current = s; if (s !== 'connected') {
                compatibleRef.current = false;
                setCompatible(false);
            } gate.update(); keyboard.updateContext(); setStatus(s); } });
        connectionRef.current = connection;
        return () => { if (performanceRef.current === diagnostics) performanceRef.current = null; diagnostics.dispose(); gate.reset(); keyboard.dispose(); keyboardRef.current = null; gateRef.current = null; connection.dispose(); connectionRef.current = null; };
    }, [interact, result, sendMessage, sendNow, performanceRef]);
    useEffect(() => { if (!roomRef.current)
        return; const game = mountRoomGame(roomRef.current, intent, duration => performanceRef.current?.gameFrame(duration)); gameRef.current = game; const initial = messageRef.current?.snapshot; if (initial)
        game.setSnapshot(initial); game.setControlSeat(selectedRef.current); game.setActionsEnabled(statusRef.current === 'connected' && compatibleRef.current); return () => { game.destroy(); gameRef.current = null; }; }, [intent, performanceRef]);
    const snapshot = message?.snapshot;
    useEffect(() => gameRef.current?.setControlSeat(selected), [selected]);
    useEffect(() => gameRef.current?.setActionsEnabled(status === 'connected' && compatible), [status, compatible]);
    const select = (id: SeatId) => { gateRef.current?.reset(); keyboardRef.current?.release(); selectedRef.current = id; setSelected(id); if (messageRef.current) setMessage(messageRef.current); keyboardRef.current?.updateContext(); };
    const available = status === 'connected' && compatible, playing = snapshot?.phase === 'playing', canAct = available && playing && snapshot?.seats[selected].controller === 'human', target = nearest(snapshot, selected), preview = target ? message?.interaction_previews[selected][target] : undefined;
    const control = (m: ClientMessage) => releaseThen(() => { gateRef.current?.reset(); if (!sendMessage(m))
        setFeedback('连接中断，请重试。'); });
    const pending = snapshot?.orders.filter(o => o.phase === 'pending') ?? [], accepted = snapshot?.orders.filter(o => o.phase === 'accepted') ?? [];
    return <main className="app-shell">
  <header className="topbar"><div><p className="eyebrow">南瓜小厨房 · 双人协作</p><h1>南瓜厨房</h1><p className="subtitle">贝贝南瓜沙拉 & 奶油南瓜汤</p></div><div className={`connection-pill ${status}`}><span className="status-dot"/>{available ? (IS_DEMO ? '网页试玩已就绪' : '房间已连接') : status === 'connected' ? '检查厨房版本…' : status === 'reconnecting' ? '正在重连' : '连接房间中'}</div></header>
  <section className="mode-banner" aria-label="游玩模式"><div><strong>{IS_DEMO ? '网页试玩 · 演示队友（规则驱动，非真实模型）' : '本地完整版 · 支持自己的 AI 接入'}</strong><p>{IS_DEMO ? '每位访客独立一局，无需安装。切走页面时计时仍会继续；刷新可回到大厅。' : '通过 MCP 连接自己的 AI；未接入时可使用演示队友。'}</p></div><a href={`${import.meta.env.BASE_URL}ai-guide.html`} target="_blank" rel="noreferrer">和自己的 AI 一起玩 ↗</a>{import.meta.env.VITE_REPOSITORY_URL && <a href={import.meta.env.VITE_REPOSITORY_URL} target="_blank" rel="noreferrer">代码与本地版 ↗</a>}</section>
  <section className="score-strip" aria-label="本局状态"><div className="timer-card"><span>剩余时间</span><strong>{snapshot?.round_ends_at_ms ? Math.max(0, Math.ceil((snapshot.round_ends_at_ms - snapshot.server_time_ms) / 1000)) : 90}<small>秒</small></strong></div><div className="metric"><span>待接 / 已接</span><strong>{pending.length} / {accepted.length}</strong></div><div className="metric"><span>完成份数</span><strong>{snapshot?.score ?? 0}</strong></div><div className="metric score-metric"><span>营业额</span><strong>{snapshot?.revenue ?? 0}</strong></div><button className="primary-button" disabled={!available || playing} onClick={() => control({ type: 'start_round', ruleset_id: RULESET_ID })}>{snapshot?.phase === 'finished' ? '再开一局' : '开始一局'}</button></section>
  <section className="order-board" aria-label="订单">{[...accepted, ...pending].map(o => { const deadline = o.phase === 'accepted' ? o.delivery_deadline_ms! : o.pending_deadline_ms; return <article key={o.id} className={`order-ticket ${o.phase}`}><span>{o.phase === 'accepted' ? '制作中' : '待接单'}</span><strong>{RECIPES[o.recipe_id].label}</strong><small>{Math.max(0, Math.ceil((deadline - snapshot!.server_time_ms) / 1000))}秒 · {o.phase === 'accepted' ? `完成 +${RECIPES[o.recipe_id].reward} / 超时 −${RECIPES[o.recipe_id].penalty}` : '到接单台按 E'}</small></article>; })}{!pending.length && !accepted.length && <p>{snapshot?.phase === 'finished' ? '打烊啦，辛苦了！' : '等候新订单…'}</p>}</section>
  <div className="main-grid"><section className="game-card" aria-label="协作地图"><div className="game-card-heading"><div><h2>一起开饭</h2><p>WASD / 方向键移动 · E 互动 · 点击地面或工位前往</p></div><span className="map-legend"><i className="legend-human"/>玩家<i className="legend-ai"/>队友</span></div><div className="game-canvas" ref={roomRef}/>
   <div className="station-nav" aria-label="工位导航">{STATION_IDS.map(id => <button key={id} disabled={!canAct} onClick={() => { const s = messageRef.current?.snapshot; if (!s)
        return; const p = approachFor(s.seats[selectedRef.current].position, id); if (p)
        requestMove({ type: 'move_to', target: p }, selectedRef.current); }}>{stationLabel(id)}</button>)}</div>
   <div className="game-actions"><button className="secondary-button" disabled={!canAct || !preview?.allowed} onClick={() => releaseThen(interact)}>{preview?.allowed ? `${operations[preview.operation]} · ${stationLabel(target!)}` : '靠近工位互动'}</button>{snapshot?.seats[selected].active_action && <button className="quiet-button" disabled={!canAct} onClick={() => intent({ type: 'cancel' })}>停下 / 暂停切配</button>}<span className="feedback" role="status">{feedback}</span></div>
  </section><aside className="side-column"><section className="panel"><h2>双人小队</h2>{(['human', 'ai'] as const).map(id => { const p = snapshot?.seats[id]; return <article className={`seat-card ${id}`} key={id}><div className="seat-heading"><span className={`seat-token ${id}`}/><strong>{id === 'human' ? '玩家' : '队友'}</strong><span className="seat-action">{p?.active_action?.type === 'chop' ? '切配中' : p?.active_action ? '走路中' : '空闲'}</span></div><div className="seat-detail"><span>手持</span><strong>{itemName(p?.held_item_id ? snapshot?.items[p.held_item_id] : undefined)}</strong></div>{id === 'ai' && <><p className="control-hint">{p?.controller === 'demo' ? '演示队友 · 非真实模型' : p?.controller === 'human' ? '人工接管中' : message?.controller_status.connected ? `MCP 队友在线${message.controller_status.waiting ? ' · 等待事件' : ''}` : IS_DEMO ? '演示已暂停 · 可恢复演示或人工接管' : '等待 MCP 队友连接'}</p><div className="seat-controls"><button disabled={!available} onClick={() => p?.controller === 'human' ? control({ type: 'set_demo', ruleset_id: RULESET_ID, enabled: true }) : control({ type: 'takeover', ruleset_id: RULESET_ID, seat_id: 'ai' })}>{p?.controller === 'human' ? '归还演示队友' : '接管队友'}</button><button disabled={!available || p?.controller === 'human'} onClick={() => control({ type: 'set_demo', ruleset_id: RULESET_ID, enabled: p?.controller !== 'demo' })}>{p?.controller === 'demo' ? '暂停演示' : '恢复演示'}</button></div></>}</article>; })}<div className="seat-select" role="group" aria-label="操作席位"><button className={selected === 'human' ? 'selected' : ''} onClick={() => select('human')}>玩家</button><button disabled={snapshot?.seats.ai.controller !== 'human'} className={selected === 'ai' ? 'selected' : ''} onClick={() => select('ai')}>队友</button></div></section>
   <section className="panel recipe-panel"><h2>今日菜谱</h2><p><strong>贝贝南瓜沙拉</strong><br />南瓜切配 → 煮熟 → 与切好的黄瓜装碗</p><p><strong>奶油南瓜汤</strong><br />南瓜切配 → 煮熟 → 锅中加奶油 → 再煮 → 盛碗</p><p className="control-hint">煮菜可以离手，端锅离灶会暂停。熟菜不会着火。碗无限供应；清理口只清掉内容物。</p></section>
   <section className="panel activity-panel"><h2>最近动静</h2><ul>{message?.events.slice(-4).reverse().map((e: GameEvent) => <li key={e.id}><span>{e.seat_id === 'human' ? '玩家' : e.seat_id === 'ai' ? '队友' : '厨房'}</span>{eventText(e.type)}</li>)}</ul></section></aside></div>
 </main>;
}

