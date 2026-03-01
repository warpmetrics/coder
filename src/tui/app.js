// Root TUI component.
// Split-pane layout: run list (left) + detail (right).
// IMPORTANT: App has NO tick/animation state. Each animated component
// manages its own interval so App only re-renders on meaningful state
// changes (cursor, poll, tab). This keeps input handling instant.

import { createElement as h, useReducer, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { Header } from './components/header.js';
import { StatusBar } from './components/status-bar.js';
import { RunList } from './components/run-list.js';
import { RunDetail } from './components/run-detail.js';
import { LogView } from './components/log-view.js';
import { extractPhases } from './layout.js';

const MAX_LOGS = 500;
const ALT_ON = '\x1b[?1049h\x1b[?25l';
const ALT_OFF = '\x1b[?25h\x1b[?1049l';
const DETAIL_TABS = ['pipeline', 'timeline', 'logs'];

const initialState = {
  view: 'main',           // 'main' (split panes) or 'logs' (full-screen logs)
  runs: [],
  selectedIndex: 0,
  detailTab: 'pipeline',  // 'pipeline' | 'timeline' | 'logs'
  logs: [],
  pollStats: null,
  lastPollAt: null,
  logScrollOffset: 0,
};

function reducer(state, action) {
  switch (action.type) {
    case 'POLL_RESULT': {
      const { openRuns, stats } = action;
      const maxIdx = Math.max(0, openRuns.length - 1);
      // Merge: carry forward groupOutcomes from previous full fetch
      // when preview (partial) data arrives without them.
      const prevById = new Map(state.runs.map(r => [r.id, r]));
      const merged = openRuns.map(r => {
        const prev = prevById.get(r.id);
        if (!prev) return r;
        if (!r.groupOutcomes && prev.groupOutcomes) {
          return {
            ...r,
            groupOutcomes: prev.groupOutcomes,
            pendingAct: r.pendingAct || prev.pendingAct,
            groups: r.groups?.size ? r.groups : prev.groups,
          };
        }
        return r;
      });
      return {
        ...state,
        runs: merged,
        pollStats: stats,
        lastPollAt: Date.now(),
        selectedIndex: Math.min(state.selectedIndex, maxIdx),
      };
    }
    case 'LOG': {
      const logs = state.logs.length >= MAX_LOGS
        ? [...state.logs.slice(-MAX_LOGS + 1), action.entry]
        : [...state.logs, action.entry];
      return { ...state, logs };
    }
    case 'MOVE_CURSOR': {
      const maxIdx = Math.max(0, state.runs.length - 1);
      const next = Math.max(0, Math.min(maxIdx, state.selectedIndex + action.delta));
      if (next === state.selectedIndex) return state;
      return { ...state, selectedIndex: next };
    }
    case 'SET_DETAIL_TAB': {
      if (state.detailTab === action.tab) return state;
      return { ...state, detailTab: action.tab };
    }
    case 'CYCLE_DETAIL_TAB': {
      const idx = DETAIL_TABS.indexOf(state.detailTab);
      const next = DETAIL_TABS[(idx + 1) % DETAIL_TABS.length];
      return { ...state, detailTab: next };
    }
    case 'SET_VIEW': {
      if (state.view === action.view) return state;
      return {
        ...state,
        view: action.view,
        logScrollOffset: action.view === 'logs' ? 0 : state.logScrollOffset,
      };
    }
    case 'SCROLL_LOGS': {
      const next = Math.max(0, state.logScrollOffset + action.delta);
      if (next === state.logScrollOffset) return state;
      return { ...state, logScrollOffset: next };
    }
    default:
      return state;
  }
}

export function App({ runner, prs, graph, repoNames, workflowLabel, concurrency, pollInterval, onLogMount }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const runningRef = useRef(true);
  const forcePollRef = useRef(null);

  // Steps live in a ref — mutated by poll callbacks, read by children on their own tick.
  const stepsRef = useRef(new Map());

  // Pre-compute phases once (graph never changes).
  const phases = useMemo(() => extractPhases(graph), [graph]);

  // Terminal dimensions.
  const rows = stdout?.rows || 24;
  const cols = stdout?.columns || 80;

  // Pane widths.
  const leftW = Math.max(30, Math.min(70, Math.floor(cols * 0.4)));
  const rightW = cols - leftW - 1; // -1 for divider

  // Alternate screen buffer.
  useEffect(() => {
    stdout?.write(ALT_ON);
    return () => stdout?.write(ALT_OFF);
  }, [stdout]);

  // Wire runner log messages into TUI state.
  useEffect(() => {
    onLogMount?.((issueId, msg) => {
      const time = new Date().toLocaleTimeString('en-US', { hour12: false });
      dispatch({ type: 'LOG', entry: { time, issueId, msg } });
    });
  }, [onLogMount]);

  // Poll loop.
  useEffect(() => {
    let timeoutId = null;

    const doPoll = async () => {
      if (!runningRef.current) return;
      try {
        prs.clearCache();
        const stats = await runner.poll({
          onStep: (issueId, step) => {
            stepsRef.current.set(issueId, { step, startedAt: Date.now() });
          },
          onClearStep: (issueId) => {
            stepsRef.current.delete(issueId);
          },
          onBeforeLog: () => {},
          onPreview: (partial) => {
            dispatch({ type: 'POLL_RESULT', openRuns: partial, stats: { total: partial.length, processing: 0, inFlight: 0 } });
          },
        });
        dispatch({ type: 'POLL_RESULT', openRuns: stats.openRuns || [], stats });
      } catch (err) {
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        dispatch({ type: 'LOG', entry: { time, issueId: null, msg: `Poll error: ${err.message}` } });
      }

      if (runningRef.current) {
        timeoutId = setTimeout(doPoll, pollInterval);
        forcePollRef.current = () => {
          if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
          doPoll();
        };
      }
    };

    doPoll();
    return () => {
      runningRef.current = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [runner, prs, pollInterval]);

  // Keyboard — all refs, zero deps. Created ONCE.
  const exitRef = useRef(exit);
  exitRef.current = exit;
  const viewRef = useRef(state.view);
  viewRef.current = state.view;

  useInput(useCallback((input, key) => {
    if (key.ctrl && input === 'c') {
      runningRef.current = false;
      exitRef.current();
      return;
    }
    if (input === 'r') { forcePollRef.current?.(); return; }

    if (input === 'l') {
      dispatch({ type: 'SET_VIEW', view: viewRef.current === 'logs' ? 'main' : 'logs' });
      return;
    }
    if (key.escape) {
      if (viewRef.current === 'logs') dispatch({ type: 'SET_VIEW', view: 'main' });
      return;
    }

    if (viewRef.current === 'main') {
      if (input === 'j' || key.downArrow) dispatch({ type: 'MOVE_CURSOR', delta: 1 });
      else if (input === 'k' || key.upArrow) dispatch({ type: 'MOVE_CURSOR', delta: -1 });
      else if (input === '1') dispatch({ type: 'SET_DETAIL_TAB', tab: 'pipeline' });
      else if (input === '2') dispatch({ type: 'SET_DETAIL_TAB', tab: 'timeline' });
      else if (input === '3') dispatch({ type: 'SET_DETAIL_TAB', tab: 'logs' });
      else if (key.tab) dispatch({ type: 'CYCLE_DETAIL_TAB' });
    }
    if (viewRef.current === 'logs') {
      if (input === 'j' || key.downArrow) dispatch({ type: 'SCROLL_LOGS', delta: -1 });
      else if (input === 'k' || key.upArrow) dispatch({ type: 'SCROLL_LOGS', delta: 1 });
    }
  }, []));

  // Layout heights: header=2, footer=2 (separator + hints).
  const headerH = 2;
  const footerH = 2;
  const mainH = Math.max(1, rows - headerH - footerH);

  const selectedRun = state.runs[state.selectedIndex] || null;

  // Full-screen logs view.
  if (state.view === 'logs') {
    return h(Box, { flexDirection: 'column', width: cols, height: rows },
      h(Header, { lastPollAt: state.lastPollAt, pollStats: state.pollStats, cols }),
      h(Box, { flexDirection: 'column', height: mainH },
        h(LogView, {
          logs: state.logs, scrollOffset: state.logScrollOffset, maxRows: mainH, cols,
        }),
      ),
      h(StatusBar, { view: 'logs', cols }),
    );
  }

  // Split-pane main view.
  return h(Box, { flexDirection: 'column', width: cols, height: rows },
    h(Header, {
      lastPollAt: state.lastPollAt, pollStats: state.pollStats, cols, dividerPos: leftW,
    }),
    h(Box, { flexDirection: 'row', height: mainH },
      h(Box, { width: leftW, flexDirection: 'column' },
        h(RunList, {
          runs: state.runs, phases, selectedIndex: state.selectedIndex,
          steps: stepsRef.current, maxRows: mainH, cols: leftW,
        }),
      ),
      h(Divider, { height: mainH }),
      h(Box, { width: rightW, flexDirection: 'column' },
        h(RunDetail, {
          run: selectedRun, phases, steps: stepsRef.current,
          logs: state.logs, tab: state.detailTab,
          maxRows: mainH, cols: rightW,
        }),
      ),
    ),
    h(StatusBar, { view: 'main', cols, dividerPos: leftW }),
  );
}

function Divider({ height }) {
  const lines = [];
  for (let i = 0; i < height; i++) {
    lines.push(h(Text, { key: i, dimColor: true }, '\u2502'));
  }
  return h(Box, { width: 1, flexDirection: 'column' }, ...lines);
}
