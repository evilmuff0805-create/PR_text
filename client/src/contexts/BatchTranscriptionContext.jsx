import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import { optimizeLargeWavForUpload } from '../utils/wav-optimization.js';
import { shouldOptimizeWavUpload } from '../utils/upload-validation.js';
import { BATCH_TERMINAL_STATUSES, MAX_BATCH_FILES, batchCounts, batchUploadFile, createBatchApi, defaultTrackLabel, isBatchId, pendingBatchKey, readPendingBatch, stageBatchFiles, validateBatchAudio, validateBatchRows, writePendingBatch } from '../utils/batch-transcription.js';
import { flushStoredBatchDrafts } from '../utils/result-drafts.js';

const BatchContext = createContext(null);

export function BatchTranscriptionProvider({ children }) {
  const { user, getToken, updateCredits } = useAuth();
  const [batch, setBatch] = useState(null);
  const [batches, setBatches] = useState([]);
  const [rows, setRows] = useState([]);
  const [language, setLanguage] = useState('');
  const [polishMode, setPolishMode] = useState('preserve');
  const [localStates, setLocalStates] = useState({});
  const [loading, setLoading] = useState(false);
  const [creationPending, setCreationPending] = useState(false);
  const [admissionsEnabled, setAdmissionsEnabled] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const batchRef = useRef(null);
  const rowsRef = useRef([]);
  const filesRef = useRef(new Map());
  const actionRef = useRef(null);
  const actionNameRef = useRef('');
  const uploadControllerRef = useRef(null);
  const editorFlushesRef = useRef(new Map());
  const ownerRef = useRef(user?.id);
  const tokenGetterRef = useRef(getToken);
  ownerRef.current = user?.id; tokenGetterRef.current = getToken;
  rowsRef.current = rows;
  const api = useMemo(() => {
    const request = createBatchApi({ getToken: () => tokenGetterRef.current() });
    return async (...args) => {
      const owner = ownerRef.current;
      try { return await request(...args); }
      catch (requestError) {
        if ([401, 403].includes(requestError.status) && ownerRef.current === owner) {
          batchRef.current = null; rowsRef.current = []; setBatch(null); setRows([]); setBatches([]); setLocalStates({});
          filesRef.current.clear(); editorFlushesRef.current.clear(); setAdmissionsEnabled(null);
        }
        throw requestError;
      }
    };
  }, []);

  const applyBatch = useCallback((next, owner) => {
    if (ownerRef.current !== owner || !next?.id) return null;
    batchRef.current = next; setBatch(next); setRows(next.items || []); setCreationPending(false);
    setBatches((current) => [next, ...current.filter((item) => item.id !== next.id)]);
    const pending = readPendingBatch(localStorage, owner);
    setPolishMode(next.polishMode || 'preserve');
    writePendingBatch(localStorage, owner, { ...(pending?.batchKey === next.batchKey ? pending : {}), id: next.id, batchKey: next.batchKey, language: next.language, polishMode: next.polishMode || 'preserve',
      files: (next.items || []).map(({ clientId, filename, label }) => ({ clientId, filename, label })) });
    if (Number.isFinite(next.creditsRemaining)) updateCredits(next.creditsRemaining);
    return next;
  }, [updateCredits]);

  const loadBatch = useCallback(async (id) => {
    if (actionRef.current && actionNameRef.current !== 'refresh') throw new Error('파일 접수나 편집 저장을 마친 뒤 다른 묶음을 열어 주세요.');
    if (!isBatchId(id)) throw new Error('묶음 작업 번호를 확인해 주세요.');
    const owner = ownerRef.current;
    const data = await api(`/api/transcribe/batches/${id}`);
    return applyBatch(data.batch, owner);
  }, [api, applyBatch]);

  useEffect(() => {
    const owner = user?.id;
    const controller = new AbortController();
    batchRef.current = null; setBatch(null); setRows([]); setBatches([]); setLocalStates({}); setBusy(''); setError(''); setNotice(''); setCreationPending(false); setAdmissionsEnabled(null);
    filesRef.current.clear(); editorFlushesRef.current.clear(); actionRef.current = null; actionNameRef.current = '';
    if (!owner) { setLoading(false); return undefined; }
    setLoading(true);
    const pending = readPendingBatch(localStorage, owner);
    api('/api/transcribe/batches', { signal: controller.signal }).then(async (data) => {
      if (controller.signal.aborted || ownerRef.current !== owner) return;
      const list = data.batches || []; setBatches(list); setAdmissionsEnabled(data.admissionsEnabled === true);
      const restored = pending?.id || list.find((item) => item.batchKey === pending?.batchKey)?.id
        || list.find((item) => !BATCH_TERMINAL_STATUSES.has(item.status))?.id;
      if (restored) {
        const detail = await api(`/api/transcribe/batches/${restored}`, { signal: controller.signal });
        if (!controller.signal.aborted) applyBatch(detail.batch, owner);
      } else if (pending) {
        setRows(pending.files); setLanguage(pending.language || ''); setPolishMode(pending.polishMode || 'preserve'); setCreationPending(true);
        setNotice('접수 상태를 다시 확인해 주세요. 업로드하지 못한 파일만 다시 선택하면 됩니다.');
      }
    }).catch((requestError) => { if (!controller.signal.aborted && ownerRef.current === owner) setError(requestError.message); })
      .finally(() => { if (!controller.signal.aborted && ownerRef.current === owner) setLoading(false); });
    return () => { controller.abort(); uploadControllerRef.current?.abort(); };
  }, [api, applyBatch, user?.id]);

  useEffect(() => {
    if (!batch?.id || BATCH_TERMINAL_STATUSES.has(batch.status) || !user?.id) return undefined;
    const id = batch.id, owner = user.id;
    let checking = false, disposed = false;
    const controller = new AbortController();
    const poll = async () => {
      if (checking || disposed || document.hidden || actionRef.current) return;
      checking = true;
      try {
        const data = await api(`/api/transcribe/batches/${id}`, { signal: controller.signal });
        if (!disposed && batchRef.current?.id === id) applyBatch(data.batch, owner);
      } catch (requestError) { if (!disposed && requestError.name !== 'AbortError') setError('작업 상태 연결을 확인하지 못했습니다. 접수된 작업을 다시 시작하지 말고 상태를 확인해 주세요.'); }
      finally { checking = false; }
    };
    const timer = window.setInterval(poll, 5_000);
    document.addEventListener('visibilitychange', poll);
    return () => { disposed = true; controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [api, applyBatch, batch?.id, batch?.status, user?.id]);

  const runAction = async (name, callback) => {
    if (actionRef.current || !user?.id) return false;
    const owner = user.id, ticket = Symbol(name); actionRef.current = ticket; actionNameRef.current = name; setBusy(name); setError(''); setNotice('');
    try { await callback(owner); return true; }
    catch (requestError) { if (ownerRef.current === owner && requestError.name !== 'AbortError') setError(requestError.message); return false; }
    finally { if (actionRef.current === ticket) { actionRef.current = null; actionNameRef.current = ''; setBusy(''); } }
  };

  const addFiles = (selection) => {
    if (actionRef.current || batchRef.current || creationPending || admissionsEnabled !== true) return;
    const files = Array.from(selection || []);
    if (rowsRef.current.length + files.length > MAX_BATCH_FILES) { setError('오디오 파일은 한 묶음에 최대 5개까지 선택할 수 있습니다.'); return; }
    for (const file of files) {
      const validationError = validateBatchAudio(file);
      if (validationError) { setError(`${file.name}: ${validationError}`); return; }
    }
    const added = files.map((file) => { const clientId = crypto.randomUUID(); filesRef.current.set(clientId, file); return { clientId, filename: file.name, label: defaultTrackLabel(file.name) }; });
    rowsRef.current = [...rowsRef.current, ...added]; setRows(rowsRef.current); setError('');
  };
  const changeLabel = (clientId, label) => {
    if (actionRef.current || batchRef.current || creationPending) return;
    rowsRef.current = rowsRef.current.map((row) => row.clientId === clientId ? { ...row, label } : row); setRows(rowsRef.current);
  };
  const moveRow = (clientId, delta) => {
    if (actionRef.current || batchRef.current || creationPending) return;
    const next = [...rowsRef.current], index = next.findIndex((row) => row.clientId === clientId), target = index + delta;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; rowsRef.current = next; setRows(next);
  };
  const removeRow = (clientId) => {
    if (actionRef.current || batchRef.current || creationPending) return;
    filesRef.current.delete(clientId); rowsRef.current = rowsRef.current.filter((row) => row.clientId !== clientId); setRows(rowsRef.current);
  };
  const selectReplacement = (clientId, file) => {
    if (!file || actionRef.current) return;
    const row = rowsRef.current.find((item) => item.clientId === clientId);
    if (!row || (row.status && row.status !== 'awaiting_upload')) return;
    const validationError = validateBatchAudio(file);
    if (validationError || file.name !== row.filename) { setError(validationError || `원래 파일 ${row.filename}을 다시 선택해 주세요. 파일 내용과 시작점도 직접 확인해 주세요.`); return; }
    filesRef.current.set(clientId, file); setLocalStates((current) => ({ ...current, [clientId]: { status: 'selected' } })); setError('');
  };

  const uploadItems = async (current, owner, selectedItems = current.items) => {
    const controller = new AbortController(); uploadControllerRef.current = controller;
    const errors = await stageBatchFiles({ items: selectedItems, getFile: (clientId) => filesRef.current.get(clientId),
      isCurrent: () => ownerRef.current === owner && !controller.signal.aborted && batchRef.current?.id === current.id,
      onStatus: (clientId, status, message) => setLocalStates((previous) => ({ ...previous, [clientId]: { status, message } })),
      prepareFile: async (file, item) => {
        if (!shouldOptimizeWavUpload(file)) return file;
        const optimized = await optimizeLargeWavForUpload(file, { signal: controller.signal, onProgress: (progress) => {
          if (ownerRef.current === owner) setLocalStates((previous) => ({ ...previous, [item.clientId]: { status: 'preparing', progress } }));
        } });
        return optimized.file;
      },
      upload: async (item, file) => {
        const formData = new FormData(); formData.append('audio', batchUploadFile(file));
        const data = await api(`/api/transcribe/batches/${current.id}/items/${item.id}/audio`, { method: 'POST', body: formData, multipart: true, signal: controller.signal });
        applyBatch(data.batch, owner);
      } });
    if (ownerRef.current !== owner) return;
    if (errors.length) { setError(errors.map(({ message }) => message).join(' ')); setNotice('접수된 파일은 유지됩니다. 미접수 파일만 확인한 뒤 다시 접수해 주세요.'); }
    else setNotice('파일 접수를 마쳤습니다. 서버가 확인한 사용 시간을 확인하고 변환 시작을 눌러 주세요.');
  };

  const stageFiles = () => runAction('upload', async (owner) => {
    let current = batchRef.current;
    if (!current) {
      if (admissionsEnabled !== true && !creationPending) throw new Error('사람별 묶음 변환을 준비 중입니다. 기존 작업의 상태 확인과 다운로드는 계속 사용할 수 있습니다.');
      const validationError = validateBatchRows(rowsRef.current); if (validationError) throw new Error(validationError);
      const saved = readPendingBatch(localStorage, owner);
      const payload = saved && !saved.id ? { batchKey: saved.batchKey, language: saved.language, polishMode: saved.polishMode || 'preserve', files: saved.files }
        : { batchKey: crypto.randomUUID(), language: language || null, polishMode, files: rowsRef.current.map(({ clientId, filename, label }) => ({ clientId, filename, label: label.trim() })) };
      writePendingBatch(localStorage, owner, payload);
      setCreationPending(true);
      try { const data = await api('/api/transcribe/batches', { method: 'POST', body: payload }); current = applyBatch(data.batch, owner); }
      catch (requestError) {
        if (requestError.status === 400 && ownerRef.current === owner) { setCreationPending(false); try { localStorage.removeItem(pendingBatchKey(owner)); } catch { /* Keep the visible form available. */ } }
        throw requestError;
      }
    }
    if (current) await uploadItems(current, owner);
  });

  const start = () => runAction('start', async (owner) => {
    const current = batchRef.current;
    if (!current?.canStart || !Number.isInteger(current.totalCredits)) throw new Error('모든 미접수 파일을 준비한 뒤 사용 시간을 다시 확인해 주세요.');
    const saved = readPendingBatch(localStorage, owner);
    const signature = `${current.items.filter((item) => item.status === 'ready').map((item) => `${item.id}:${item.currentOperationId || item.operationId || ''}:${item.attemptIndex ?? item.attempt ?? ''}`).join(',')}:${current.totalCredits}`;
    const attempt = saved?.startAttempt?.signature === signature ? saved.startAttempt : { signature, requestId: crypto.randomUUID() };
    writePendingBatch(localStorage, owner, { ...saved, startAttempt: attempt });
    const data = await api(`/api/transcribe/batches/${current.id}/start`, { method: 'POST', body: { requestId: attempt.requestId, expectedCredits: current.totalCredits } });
    applyBatch(data.batch, owner);
  });
  const retryItem = (itemId) => runAction('retry', async (owner) => {
    const current = batchRef.current, item = current?.items.find((row) => row.id === itemId);
    if (item?.status !== 'failed' || batchCounts(current).active) throw new Error('실패가 확정된 파일만 다른 변환이 끝난 뒤 재시도할 수 있습니다.');
    const saved = readPendingBatch(localStorage, owner);
    const attemptKey = `${item.currentOperationId || item.operationId || ''}:${item.attemptIndex ?? item.attempt ?? ''}`;
    const savedAttempt = saved?.retryAttempts?.[itemId];
    const requestId = savedAttempt?.attemptKey === attemptKey ? savedAttempt.requestId : crypto.randomUUID();
    writePendingBatch(localStorage, owner, { ...saved, retryAttempts: { ...saved?.retryAttempts, [itemId]: { attemptKey, requestId } } });
    const data = await api(`/api/transcribe/batches/${current.id}/items/${itemId}/retry`, { method: 'POST', body: { requestId } });
    const updated = applyBatch(data.batch, owner);
    if (updated && filesRef.current.has(item.clientId)) await uploadItems(updated, owner, updated.items.filter((row) => row.id === itemId));
    else setNotice('재시도할 원래 파일을 다시 선택하고 접수해 주세요. 완료된 파일은 다시 변환하지 않습니다.');
  });
  const cancel = () => runAction('cancel', async (owner) => {
    const current = batchRef.current; if (!current) return;
    const data = await api(`/api/transcribe/batches/${current.id}`, { method: 'DELETE' }); applyBatch(data.batch, owner);
    setNotice('미완료 파일의 취소를 요청했습니다. 이미 완료된 결과는 유지됩니다.');
  });
  const refresh = (id = batchRef.current?.id) => runAction('refresh', () => loadBatch(id));
  const beginNew = () => {
    if (actionRef.current) return;
    if (creationPending) { setError('먼저 접수 상태를 다시 확인해 주세요. 같은 접수 요청을 확인하여 중복 묶음을 만들지 않습니다.'); return; }
    if (batchRef.current && !BATCH_TERMINAL_STATUSES.has(batchRef.current.status)) { setError('접수된 묶음을 먼저 완료하거나 취소해 주세요.'); return; }
    batchRef.current = null; rowsRef.current = []; filesRef.current.clear(); setBatch(null); setRows([]); setLocalStates({}); setError(''); setNotice('');
    setPolishMode('preserve');
    if (user?.id) { try { localStorage.removeItem(pendingBatchKey(user.id)); } catch { /* History is stored on the server. */ } }
  };
  const registerEditor = useCallback((logId, flush) => { if (flush) editorFlushesRef.current.set(logId, flush); else editorFlushesRef.current.delete(logId); }, []);
  const clearError = useCallback(() => setError(''), []);
  const flushEditors = useCallback(async () => { for (const flush of editorFlushesRef.current.values()) await flush(); }, []);
  const downloadZip = (id = batchRef.current?.id) => runAction('archive', async (owner) => {
    if (!isBatchId(id)) throw new Error('묶음 작업을 먼저 선택해 주세요.');
    await flushEditors();
    const data = await api(`/api/transcribe/batches/${id}`), current = data.batch;
    if (ownerRef.current !== owner) return;
    if (!batchCounts(current).completed) throw new Error('완료된 파일이 있어야 ZIP을 내려받을 수 있습니다.');
    await flushStoredBatchDrafts({ items: current.items, storage: sessionStorage, ownerId: owner,
      fetchLog: (logId) => api(`/api/auth/transcription/${logId}`),
      saveLog: (logId, segments) => api(`/api/auth/transcription/${logId}/segments`, { method: 'PUT', body: { segments } }) });
    const counts = batchCounts(current);
    const blob = await api(`/api/transcribe/batches/${id}/archive`, { method: 'POST', body: { allowPartial: counts.completed !== counts.total }, download: true });
    if (ownerRef.current !== owner) return;
    const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `person-subtitles-${id.slice(0, 8)}.zip`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
    setNotice(`완료된 ${counts.completed}개 파일의 최신 편집본을 ZIP으로 내려받았습니다. 나머지 파일은 포함되지 않습니다.`);
  });

  return <BatchContext.Provider value={{ batch, batches, rows, language, setLanguage, polishMode, setPolishMode, localStates, loading, creationPending, admissionsEnabled, busy, error, notice, api,
    addFiles, changeLabel, moveRow, removeRow, selectReplacement, stageFiles, start, retryItem, cancel, refresh, beginNew, loadBatch,
    registerEditor, flushEditors, downloadZip, clearError, hasFile: (clientId) => filesRef.current.has(clientId) }}>{children}</BatchContext.Provider>;
}

export const useBatchTranscription = () => useContext(BatchContext);
