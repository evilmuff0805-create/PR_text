import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AuthModal from '../components/AuthModal.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { createOutreachApi } from '../utils/outreach-api.js';
import { contactEligibility, OUTREACH_CATEGORIES, OUTREACH_CSV_COLUMNS, previewOutreachCsv } from '../utils/outreach-csv.js';
import { outreachFeedback } from '../utils/outreach-feedback.js';

const CATEGORY_LABELS = Object.fromEntries(OUTREACH_CATEGORIES.map(({ value, label }) => [value, label]));
const CAMPAIGN_LABELS = { draft: '초안', queued: '발송 대기', running: '발송 중', paused: '일시정지', completed: '완료' };
const MESSAGE_LABELS = { pending: '대기', claimed: '처리 준비', sending: '전송 중', sent: '메일 서버 접수', failed: '실패', uncertain: '전송 확인 필요', skipped: '제외' };
const FINAL_MESSAGE_STATUSES = new Set(['sent', 'failed', 'uncertain', 'skipped']);
const EMPTY_CONTACT = {
  channelId: '', channelName: '', channelUrl: '', category: 'general', country: '',
  subscriberCount: '', email: '', publicEmailSource: '', koreaVerified: false,
  koreaEvidence: '', channelCheckedAt: '', metadataSource: 'manual', consentStatus: 'unknown',
  consentEvidence: '', consentGrantedAt: '',
};

function localDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

function displayDate(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString('ko-KR') : '미확인';
}

function Field({ label, hint, children, wide = false }) {
  return <label className={`outreach-field${wide ? ' outreach-field--wide' : ''}`}>
    <span>{label}</span>{children}{hint && <small>{hint}</small>}
  </label>;
}

function CategorySelect({ value, onChange, disabled = false }) {
  return <select value={value} onChange={onChange} disabled={disabled}>
    {OUTREACH_CATEGORIES.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
  </select>;
}

function DeliveryReason({ code }) {
  const feedback = outreachFeedback(code);
  return <div><small>{feedback.message}</small>{feedback.supportCode && <details><summary>지원용 코드 보기</summary><code>{feedback.supportCode}</code></details>}</div>;
}

export default function OutreachPage() {
  const { user, getToken } = useAuth();
  const currentUserRef = useRef(user?.id);
  currentUserRef.current = user?.id;
  const api = useMemo(() => {
    const request = createOutreachApi(getToken);
    const userId = user?.id;
    return async (...args) => {
      try {
        const response = await request(...args);
        if (currentUserRef.current !== userId) throw Object.assign(new Error('로그인 계정이 변경되었습니다.'), { name: 'AbortError' });
        return response;
      } catch (requestError) {
        if (currentUserRef.current !== userId) throw Object.assign(new Error('로그인 계정이 변경되었습니다.'), { name: 'AbortError' });
        throw requestError;
      }
    };
  }, [getToken, user?.id]);
  const [showLogin, setShowLogin] = useState(false);
  const loginButtonRef = useRef(null);
  const contactHeadingRef = useRef(null);
  const [access, setAccess] = useState(null);
  const [accessError, setAccessError] = useState(null);
  const [statusVersion, setStatusVersion] = useState(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState('');
  const actionRef = useRef(false);
  const [contactForm, setContactForm] = useState({ ...EMPTY_CONTACT });
  const [contacts, setContacts] = useState([]);
  const [totalContacts, setTotalContacts] = useState(0);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactPage, setContactPage] = useState(1);
  const [contactQuery, setContactQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [selectedContacts, setSelectedContacts] = useState(new Set());
  const [search, setSearch] = useState({ query: '', category: 'web_entertainment' });
  const [discovery, setDiscovery] = useState(null);
  const [searchedCriteria, setSearchedCriteria] = useState(null);
  const [csvText, setCsvText] = useState('');
  const [csvName, setCsvName] = useState('');
  const [csvPreview, setCsvPreview] = useState(null);
  const [csvError, setCsvError] = useState('');
  const csvReadRef = useRef(0);
  const [campaignForm, setCampaignForm] = useState({ name: '', subject: '', body: '' });
  const defaultsAppliedRef = useRef(false);
  const [campaigns, setCampaigns] = useState([]);
  const [campaignPage, setCampaignPage] = useState(1);
  const [totalCampaigns, setTotalCampaigns] = useState(0);
  const [campaignId, setCampaignId] = useState('');
  const [campaignDetail, setCampaignDetail] = useState(null);
  const [preview, setPreview] = useState(null);
  const [sampleId, setSampleId] = useState('');
  const [schedule, setSchedule] = useState('');
  const [queueMode, setQueueMode] = useState('manual');
  const queueAttemptRef = useRef(null);
  const [testMessage, setTestMessage] = useState(null);
  const [testMessageError, setTestMessageError] = useState('');

  const status = access?.userId === user?.id ? access?.status : null;
  const authorized = status?.admin === true && !accessError;
  const databaseReady = authorized && status.databaseReady === true;
  const canSend = databaseReady && status.sendingEnabled === true && status.smtpConfigured === true && status.publicUrlConfigured === true && status.limitsConfigured === true;
  const campaign = campaignDetail?.campaign?.id === campaignId ? campaignDetail.campaign : null;
  const recheckingExpired = Boolean(contactForm.id && contactForm.metadataExpiredAt);
  const activePreview = preview?.campaignId === campaignId ? preview : null;
  const sample = activePreview?.samples?.find(({ contactId }) => contactId === sampleId) || activePreview?.samples?.[0];

  const reportError = useCallback((requestError) => {
    if (requestError.name === 'AbortError') return;
    setError(requestError);
    if (requestError.status === 401 || requestError.status === 403) setAccessError(requestError);
  }, []);

  useEffect(() => {
    setAccess(null); setAccessError(null); setError(null); setSuccess('');
    setContacts([]); setCampaigns([]); setCampaignDetail(null); setCampaignId('');
    setSelectedContacts(new Set()); setDiscovery(null); setPreview(null);
    setContactForm({ ...EMPTY_CONTACT }); setCsvPreview(null); setCsvText(''); setCsvName('');
    setCsvError(''); setContactPage(1); setContactQuery(''); setAppliedQuery('');
    setCampaignPage(1); setTotalCampaigns(0); csvReadRef.current += 1;
    setTestMessage(null); setTestMessageError('');
    setSchedule(''); setQueueMode('manual'); setShowLogin(false); setBusy(''); actionRef.current = false;
    defaultsAppliedRef.current = false;
    setCampaignForm({ name: '', subject: '', body: '' });
  }, [user?.id]);

  useEffect(() => {
    const controller = new AbortController();
    setAccessError(null);
    if (user) {
      api('/status', { signal: controller.signal }).then((data) => {
        if (controller.signal.aborted) return;
        if (data.admin !== true) throw Object.assign(new Error('관리자 권한이 필요합니다.'), { status: 403 });
        setAccess({ userId: user.id, status: data });
        if (!defaultsAppliedRef.current) {
          setCampaignForm({ name: '', subject: data.defaults?.subject || '', body: data.defaults?.body || '' });
          defaultsAppliedRef.current = true;
        }
      }).catch((requestError) => {
        if (!controller.signal.aborted) setAccessError(requestError);
      });
    }
    return () => controller.abort();
  }, [api, user?.id, statusVersion]);

  useEffect(() => {
    if (!databaseReady) return undefined;
    const controller = new AbortController();
    setContactsLoading(true);
    Promise.all([
      api(`/contacts?page=${contactPage}&limit=50&q=${encodeURIComponent(appliedQuery)}`, { signal: controller.signal }),
      api(`/campaigns?page=${campaignPage}&limit=50`, { signal: controller.signal }),
    ]).then(([contactData, campaignData]) => {
      if (controller.signal.aborted) return;
      setContacts(contactData.contacts || []);
      setTotalContacts(contactData.total || 0);
      setCampaigns((current) => campaignPage === 1 ? campaignData.campaigns || []
        : [...new Map([...current, ...(campaignData.campaigns || [])].map((item) => [item.id, item])).values()]);
      setTotalCampaigns(campaignData.total || 0);
    }).catch(reportError).finally(() => { if (!controller.signal.aborted) setContactsLoading(false); });
    return () => controller.abort();
  }, [api, databaseReady, contactPage, appliedQuery, campaignPage, refreshVersion, reportError]);

  useEffect(() => {
    setPreview(null); setSampleId(''); queueAttemptRef.current = null;
  }, [campaignId]);

  useEffect(() => {
    if (!databaseReady || !campaignId) return undefined;
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || controller.signal.aborted) return;
      loading = true;
      try {
        const detail = await api(`/campaigns/${encodeURIComponent(campaignId)}`, { signal: controller.signal });
        if (!controller.signal.aborted) setCampaignDetail(detail);
      } catch (requestError) { if (!controller.signal.aborted) reportError(requestError); }
      finally { loading = false; }
    };
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api, databaseReady, campaignId, refreshVersion, reportError]);

  useEffect(() => {
    if (!databaseReady || !testMessage?.id || FINAL_MESSAGE_STATUSES.has(testMessage.status)) return undefined;
    const controller = new AbortController();
    const id = testMessage.id;
    let loading = false;
    const load = async () => {
      if (loading || controller.signal.aborted || document.hidden) return;
      loading = true;
      try {
        const result = await api(`/messages/${encodeURIComponent(id)}`, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setTestMessage((current) => current?.id === id ? result.message : current);
          setTestMessageError('');
        }
      } catch (requestError) {
        if (!controller.signal.aborted) { setTestMessageError(requestError.message); reportError(requestError); }
      } finally { loading = false; }
    };
    load();
    const timer = setInterval(load, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api, databaseReady, testMessage?.id, testMessage?.status, reportError]);

  const runAction = async (name, action) => {
    if (actionRef.current) return;
    const actionId = Symbol(name);
    actionRef.current = actionId; setBusy(name); setError(null); setSuccess('');
    try { await action(); }
    catch (requestError) { reportError(requestError); }
    finally { if (actionRef.current === actionId) { actionRef.current = false; setBusy(''); } }
  };

  const updateContactField = (field, value) => setContactForm((current) => ({ ...current, [field]: value }));
  const editContact = (contact) => {
    setContactForm({
      ...EMPTY_CONTACT, ...contact,
      channelName: contact.channelName || '', channelUrl: contact.channelUrl || '',
      country: contact.country || '', subscriberCount: contact.subscriberCount ?? '',
      koreaVerified: contact.koreaVerified === true,
      channelCheckedAt: localDateTime(contact.channelCheckedAt),
      consentGrantedAt: localDateTime(contact.consentGrantedAt),
    });
    contactHeadingRef.current?.focus();
  };

  const chooseChannel = (channel) => {
    const previous = recheckingExpired || contactForm.channelId === channel.channelId ? contactForm : contacts.find((contact) => contact.channelId === channel.channelId);
    setContactForm({
      ...EMPTY_CONTACT, ...previous,
      channelId: channel.channelId, channelName: channel.channelName,
      channelUrl: channel.channelUrl, category: channel.category,
      subscriberCount: channel.subscriberCount, country: channel.country || '',
      koreaVerified: channel.koreaVerified === true, koreaEvidence: previous?.koreaEvidence || '',
      channelCheckedAt: localDateTime(channel.checkedAt), metadataSource: 'youtube_api',
      consentGrantedAt: previous?.id ? localDateTime(previous.consentGrantedAt) : previous?.consentGrantedAt || '',
    });
    contactHeadingRef.current?.focus();
  };

  const saveContact = (event) => {
    event.preventDefault();
    runAction('contact', async () => {
      const subscriberCount = contactForm.subscriberCount === '' ? null : Number(contactForm.subscriberCount);
      if (subscriberCount !== null && (!Number.isSafeInteger(subscriberCount) || subscriberCount < 0)) throw new Error('구독자 수는 0 이상의 정수로 입력해 주세요.');
      if (!contactForm.country && contactForm.koreaVerified && !contactForm.koreaEvidence.trim()) throw new Error('한국 채널임을 확인한 근거를 입력해 주세요.');
      if (contactForm.consentStatus === 'granted' && (!contactForm.consentEvidence.trim() || !contactForm.consentGrantedAt)) throw new Error('명시적 수신 동의 근거와 동의일을 입력해 주세요.');
      const payload = Object.fromEntries(OUTREACH_CSV_COLUMNS.map((key) => [key, contactForm[key]]));
      payload.subscriberCount = subscriberCount; payload.country = contactForm.country.trim().toUpperCase();
      payload.channelCheckedAt = contactForm.channelCheckedAt ? new Date(contactForm.channelCheckedAt).toISOString() : null;
      payload.consentGrantedAt = contactForm.consentGrantedAt ? new Date(contactForm.consentGrantedAt).toISOString() : null;
      if (payload.consentGrantedAt && Date.parse(payload.consentGrantedAt) > Date.now()) throw new Error('수신 동의일은 현재보다 미래일 수 없습니다.');
      const id = contactForm.id;
      await api(id ? `/contacts/${encodeURIComponent(id)}` : '/contacts', { method: id ? 'PATCH' : 'POST', body: payload });
      setPreview(null);
      if (id) setSelectedContacts((current) => { const next = new Set(current); next.delete(id); return next; });
      setContactForm({ ...EMPTY_CONTACT }); setRefreshVersion((value) => value + 1);
      setSuccess(id ? '연락처를 수정했습니다.' : '연락처를 등록했습니다.');
    });
  };

  const discoverChannels = (pageToken) => runAction('discover', async () => {
    const criteria = pageToken ? searchedCriteria : { ...search };
    if (!criteria?.query.trim()) throw new Error('검색할 채널명이나 키워드를 입력해 주세요.');
    const result = await api('/discover', { method: 'POST', body: { ...criteria, ...(pageToken ? { pageToken } : {}) } });
    setSearchedCriteria(criteria); setDiscovery(result);
  });

  const selectCsv = async (event) => {
    const file = event.target.files?.[0];
    const readId = ++csvReadRef.current;
    setCsvText(''); setCsvPreview(null); setCsvError(''); setCsvName('');
    if (!file) return;
    try {
      if (file.size > 512000) throw new Error('CSV는 512,000바이트 이하 파일로 선택해 주세요.');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
      catch { throw new Error('UTF-8 형식의 CSV 파일을 선택해 주세요.'); }
      if (readId !== csvReadRef.current) return;
      const result = previewOutreachCsv(text, { maxRows: status.maxImportRows || 200 });
      setCsvText(text); setCsvName(file.name); setCsvPreview(result);
    } catch (csvFailure) { if (readId === csvReadRef.current) setCsvError(csvFailure.message); }
  };

  const importCsv = () => runAction('import', async () => {
    if (!csvPreview || csvPreview.errorCount) return;
    const result = await api('/contacts/import', { method: 'POST', body: { csv: csvText } });
    setSuccess(`${result.importedCount}개 연락처를 등록했습니다.`);
    setCsvPreview(null); setCsvText(''); setCsvName(''); setContactPage(1);
    setRefreshVersion((value) => value + 1);
  });

  const saveCampaign = (event) => {
    event.preventDefault();
    runAction('campaign', async () => {
      if (!selectedContacts.size) throw new Error('수신 동의와 채널 정보가 확인된 연락처를 선택해 주세요.');
      if (selectedContacts.size > 200) throw new Error('캠페인은 최대 200개 연락처를 선택할 수 있습니다.');
      const result = await api('/campaigns', { method: 'POST', body: { ...campaignForm, contactIds: [...selectedContacts] } });
      setCampaignPage(1);
      setCampaignId(result.campaign.id); setCampaignDetail({ campaign: result.campaign, messages: [] });
      setRefreshVersion((value) => value + 1); setSuccess('캠페인 초안을 저장했습니다. 문안과 발송 대상을 미리 확인해 주세요.');
    });
  };

  const previewCampaign = () => runAction('preview', async () => {
    setPreview(null); queueAttemptRef.current = null;
    const result = await api(`/campaigns/${encodeURIComponent(campaignId)}/preview`, { method: 'POST' });
    setPreview({ ...result, campaignId }); setSampleId(result.samples?.[0]?.contactId || '');
    queueAttemptRef.current = null;
  });

  const queueCampaign = () => runAction('queue', async () => {
    if (!activePreview || !activePreview.eligibleCount) throw new Error('발송 가능한 대상과 문안을 먼저 미리 확인해 주세요.');
    const scheduledAt = queueMode === 'scheduled' && schedule ? new Date(schedule).toISOString() : undefined;
    if (queueMode === 'scheduled' && (!scheduledAt || Date.parse(scheduledAt) <= Date.now())) throw new Error('예약 시각은 현재보다 미래로 선택해 주세요.');
    const attemptKey = `${campaignId}:${activePreview.previewRevision}:${scheduledAt || ''}`;
    if (queueAttemptRef.current?.key !== attemptKey) queueAttemptRef.current = { key: attemptKey, requestId: globalThis.crypto.randomUUID() };
    const result = await api(`/campaigns/${encodeURIComponent(campaignId)}/queue`, {
      method: 'POST', body: { requestId: queueAttemptRef.current.requestId, previewRevision: activePreview.previewRevision, ...(scheduledAt ? { scheduledAt } : {}) },
    });
    setCampaignDetail((current) => ({ ...current, campaign: result.campaign }));
    setRefreshVersion((value) => value + 1);
    setSuccess(scheduledAt ? '예약을 등록했습니다. 예약 시각부터 순차 발송합니다.' : '발송 대기열에 저장했습니다. 준비가 완료되면 순차 발송 시작을 눌러 주세요.');
  });

  const changeCampaignState = (action) => runAction(action, async () => {
    const result = await api(`/campaigns/${encodeURIComponent(campaignId)}/${action}`, { method: 'POST' });
    setCampaignDetail((current) => ({ ...current, campaign: result.campaign }));
    setRefreshVersion((value) => value + 1);
    setSuccess(action === 'pause' ? '일시정지를 요청했습니다. 이미 전송 중인 메일은 완료될 수 있습니다.' : '순차 발송을 시작했습니다.');
  });

  const recordRevocation = (contact) => runAction('revoke', async () => {
    await api(`/contacts/${encodeURIComponent(contact.id)}`, { method: 'PATCH', body: { consentStatus: 'revoked' } });
    setSelectedContacts((current) => { const next = new Set(current); next.delete(contact.id); return next; });
    setPreview(null); setRefreshVersion((value) => value + 1);
    setSuccess('수신 동의 철회를 기록했습니다. 이 주소는 이후 발송 대상에서 제외합니다.');
  });

  const testSend = () => runAction('test', async () => {
    const result = await api('/test-send', { method: 'POST', body: { subject: campaign.subject, body: campaign.body } });
    setTestMessage(result.message); setTestMessageError('');
    setSuccess('본인 테스트 메일을 발송 대기열에 등록했습니다. 수신함에서 직접 확인해 주세요.');
  });

  if (!user) return <div className="outreach-page">
    <section className="outreach-panel outreach-access" aria-labelledby="outreach-login-title">
      <p className="workspace-kicker">OUTREACH</p><h1 id="outreach-login-title">관리자 로그인</h1>
      <p>허용된 관리자 계정으로 로그인하면 홍보 연락처와 발송을 관리할 수 있습니다.</p>
      <button ref={loginButtonRef} type="button" className="button button--primary" onClick={() => setShowLogin(true)}>로그인</button>
    </section>
    <AuthModal isOpen={showLogin} onClose={() => setShowLogin(false)} restoreFocusRef={loginButtonRef} returnPath="/admin/outreach" />
  </div>;

  if (!authorized) return <div className="outreach-page"><section className="outreach-panel outreach-access" aria-labelledby="outreach-access-title">
    <p className="workspace-kicker">OUTREACH</p><h1 id="outreach-access-title">홍보 메일 관리</h1>
    {accessError ? <>
      <p role="alert">{accessError.status === 403 ? '관리자 권한이 필요합니다. 허용된 계정으로 로그인해 주세요.' : accessError.message}</p>
      <button type="button" className="button button--secondary" onClick={() => setStatusVersion((value) => value + 1)}>접근 상태 다시 확인</button>
    </> : <p role="status">관리자 접근 권한을 확인하고 있습니다.</p>}
  </section></div>;

  return <div className="outreach-page">
    <header className="outreach-heading">
      <div><p className="workspace-kicker">OUTREACH</p><h1 className="workspace-title">홍보 메일 관리</h1>
        <p className="workspace-description">채널을 확인하고 수신 동의를 기록한 뒤, 검토한 문안을 순차 발송하세요.</p></div>
      <button type="button" className="button button--secondary" disabled={Boolean(busy)} onClick={() => { setStatusVersion((value) => value + 1); setRefreshVersion((value) => value + 1); }}>설정 상태 새로고침</button>
    </header>
    {error && <div className="outreach-alert outreach-alert--error" role="alert"><p>{error.message}</p>
      {Array.isArray(error.rowErrors) && <ul>{error.rowErrors.slice(0, 10).map((row, index) => <li key={index}>{row.row || row.line || '?'}행: {row.field || row.fields?.join(', ') || '입력값 확인 필요'}</li>)}</ul>}
    </div>}
    {success && <p className="outreach-alert" role="status">{success}</p>}

    <section className="outreach-panel" aria-labelledby="outreach-status-title">
      <div className="outreach-panel__heading"><h2 id="outreach-status-title">발송 준비 상태</h2><span className={`outreach-badge${canSend ? ' is-ready' : ''}`}>{canSend ? '발송 사용 가능' : '준비 중'}</span></div>
      <dl className="outreach-status-grid">
        <div><dt>발신자</dt><dd>{status.sender?.name || '코드밋'} · {status.fromEmail || 'codemeet@naver.com'}</dd></div>
        <div><dt>연락처 저장</dt><dd>{databaseReady ? '준비 완료' : '준비 중'}</dd></div>
        <div><dt>채널 검색</dt><dd>{status.discoveryConfigured ? '준비 완료' : '준비 중'}</dd></div>
        <div><dt>메일 발송 설정</dt><dd>{status.smtpConfigured ? '준비 완료' : '준비 중'}</dd></div>
        <div><dt>수신거부 링크</dt><dd>{status.publicUrlConfigured ? '준비 완료' : '준비 중'}</dd></div>
        <div><dt>발송 속도</dt><dd>{status.limitsConfigured ? `하루 최대 ${status.dailyLimit}건 · ${status.intervalSeconds || status.minIntervalSeconds}초 간격` : '발송 한도 설정 확인 필요'}</dd></div>
      </dl>
      {!canSend && <p className="outreach-note">발송 기능을 준비 중입니다. 설정이 완료되면 본인 테스트와 예약·순차 발송을 사용할 수 있습니다.</p>}
      {!databaseReady && <p className="outreach-note">{status.databaseMessage || '연락처와 캠페인 저장 기능을 준비 중입니다.'}</p>}
    </section>

    <section className="outreach-panel" aria-labelledby="outreach-discovery-title">
      <div className="outreach-panel__heading"><h2 id="outreach-discovery-title">1. 채널 후보 검색</h2><span className="outreach-badge">구독자 10만 명 이상</span></div>
      <p className="outreach-note">검색 분류를 선택해 후보를 찾으세요. 실제 웹예능·배우 개인 채널 여부는 직접 확인해 주세요. 이메일은 자동 수집하지 않습니다.</p>
      <form className="outreach-search" onSubmit={(event) => { event.preventDefault(); discoverChannels(); }}>
        <Field label="검색 분류"><CategorySelect value={search.category} onChange={(event) => setSearch((current) => ({ ...current, category: event.target.value }))} /></Field>
        <Field label="채널명 또는 키워드"><input value={search.query} maxLength={100} onChange={(event) => setSearch((current) => ({ ...current, query: event.target.value }))} placeholder="채널명, 웹예능 등" required /></Field>
        <button type="submit" className="button button--secondary" disabled={Boolean(busy) || !status.discoveryConfigured}>{busy === 'discover' ? '검색 중…' : '후보 검색'}</button>
      </form>
      {!status.discoveryConfigured && <p className="outreach-note">채널 검색을 준비 중입니다. 준비가 완료되면 검색할 수 있습니다.</p>}
      {discovery && <>
        <p className="outreach-note">검색 결과: {searchedCriteria?.query} · {CATEGORY_LABELS[searchedCriteria?.category]}</p>
        <div className="outreach-table-wrap"><table className="outreach-table"><caption className="sr-only">구독자 10만 명 이상 채널 후보</caption>
          <thead><tr><th scope="col">채널</th><th scope="col">구독자</th><th scope="col">한국 채널 확인</th><th scope="col">등록</th></tr></thead>
          <tbody>{discovery.channels?.map((channel) => <tr key={channel.channelId}>
            <td><a className="text-link" href={channel.channelUrl} target="_blank" rel="noopener noreferrer">{channel.channelName}</a><small>{CATEGORY_LABELS[channel.category]}</small></td>
            <td>{Number(channel.subscriberCount).toLocaleString()}명</td><td>{channel.koreaVerified ? '국가 KR 기재' : '국가 미기재 · 직접 확인 필요'}</td>
            <td><button type="button" className="button button--secondary" disabled={Boolean(busy) || !databaseReady} onClick={() => chooseChannel(channel)}>{recheckingExpired ? '이 연락처의 채널로 확인' : '등록 양식으로'}</button></td>
          </tr>)}</tbody>
        </table></div>
        {!discovery.channels?.length && <p className="outreach-empty">이번 검색에 조건을 충족하는 후보가 없습니다.</p>}
        {discovery.nextPageToken && <button type="button" className="button button--secondary" disabled={Boolean(busy)} onClick={() => discoverChannels(discovery.nextPageToken)}>다음 후보 보기</button>}
      </>}
    </section>

    <section className="outreach-panel" aria-labelledby="outreach-contact-title">
      <div className="outreach-panel__heading"><h2 id="outreach-contact-title" ref={contactHeadingRef} tabIndex={-1}>2. {contactForm.id ? '연락처 수정' : '연락처 등록'}</h2>
        {contactForm.id && <button type="button" className="button button--secondary" disabled={Boolean(busy)} onClick={() => setContactForm({ ...EMPTY_CONTACT })}>새 연락처 작성</button>}</div>
      <p className="outreach-note">공개 이메일 출처와 홍보 메일 수신 동의는 별도입니다. 동의 미확인 연락처도 저장할 수 있지만 발송 대상에는 포함되지 않습니다.</p>
      {recheckingExpired && <p className="outreach-alert">{contactForm.email}의 채널 정보를 다시 확인하고 있습니다. <a className="text-link" href="#outreach-discovery-title">후보 검색</a>에서 해당 채널을 고른 뒤 ‘연락처 수정 저장’을 눌러 주세요. 기존 이메일과 수신 동의 기록을 유지합니다.</p>}
      <form onSubmit={saveContact}>
        <fieldset className="outreach-fields" disabled={!databaseReady || Boolean(busy)}><legend className="sr-only">채널 및 수신 동의 정보</legend>
          <Field label="채널명"><input value={contactForm.channelName} onChange={(event) => updateContactField('channelName', event.target.value)} maxLength={200} required /></Field>
          <Field label="분류"><CategorySelect value={contactForm.category} onChange={(event) => updateContactField('category', event.target.value)} /></Field>
          <Field label="채널 주소"><input type="url" value={contactForm.channelUrl} onChange={(event) => updateContactField('channelUrl', event.target.value)} maxLength={1500} placeholder="https://www.youtube.com/…" /></Field>
          <Field label="채널 ID (선택)"><input value={contactForm.channelId || ''} onChange={(event) => updateContactField('channelId', event.target.value)} maxLength={24} pattern="UC[A-Za-z0-9_-]{22}" /></Field>
          <Field label="구독자 수"><input type="number" min="0" step="1" value={contactForm.subscriberCount} onChange={(event) => updateContactField('subscriberCount', event.target.value)} placeholder="100000" /></Field>
          <Field label="국가 코드" hint="한국은 KR, 미기재 채널은 빈칸으로 두세요."><input value={contactForm.country} onChange={(event) => updateContactField('country', event.target.value.toUpperCase())} maxLength={2} pattern="[A-Za-z]{2}" placeholder="KR" /></Field>
          <Field label="채널 정보 확인일" hint="기기 현지 시각 · 발송 전 30일 이내 확인이 필요합니다."><input type="datetime-local" step="1" value={contactForm.channelCheckedAt} onChange={(event) => updateContactField('channelCheckedAt', event.target.value)} /></Field>
          <div className="outreach-field"><span>채널 정보 출처</span><p>{contactForm.metadataSource === 'youtube_api' ? 'YouTube 검색' : '직접 입력'}</p><small>검색 정보는 30일이 지나면 삭제되어 재확인이 필요합니다.</small></div>
          {!contactForm.country && <>
            <label className="outreach-check"><input type="checkbox" checked={contactForm.koreaVerified} onChange={(event) => updateContactField('koreaVerified', event.target.checked)} />한국 채널임을 직접 확인했습니다</label>
            <Field label="한국 채널 확인 근거"><input value={contactForm.koreaEvidence} onChange={(event) => updateContactField('koreaEvidence', event.target.value)} maxLength={2000} required={contactForm.koreaVerified} placeholder="공식 소개 주소와 확인 내용" /></Field>
          </>}
          <Field label="공개 이메일" hint={contactForm.id ? '등록한 주소는 변경할 수 없습니다. 다른 주소는 새 연락처로 등록하세요.' : undefined}><input type="email" value={contactForm.email} onChange={(event) => updateContactField('email', event.target.value)} maxLength={254} readOnly={Boolean(contactForm.id)} required /></Field>
          <Field label="공개 이메일 출처" hint="이메일을 직접 확인한 공식 페이지 주소를 기록하세요."><input type="url" value={contactForm.publicEmailSource} onChange={(event) => updateContactField('publicEmailSource', event.target.value)} maxLength={1500} required /></Field>
          <Field label="홍보 메일 수신 동의"><select value={contactForm.consentStatus} onChange={(event) => updateContactField('consentStatus', event.target.value)}>
            <option value="unknown">미확인 · 발송 제외</option><option value="granted">명시적 수신 동의 확인</option><option value="revoked">수신 동의 철회 · 발송 제외</option>
          </select></Field>
          <Field label="수신 동의일" hint="기기 현지 시각 · 공개 이메일 확인일과 구분하세요."><input type="datetime-local" step="1" value={contactForm.consentGrantedAt} onChange={(event) => updateContactField('consentGrantedAt', event.target.value)} required={contactForm.consentStatus === 'granted'} /></Field>
          <Field label="명시적 수신 동의 근거" wide hint="홍보 메일을 받겠다는 회신·신청 내용과 확인 가능한 출처를 10자 이상 기록하세요."><textarea rows={3} value={contactForm.consentEvidence} onChange={(event) => updateContactField('consentEvidence', event.target.value)} minLength={contactForm.consentStatus === 'granted' ? 10 : undefined} maxLength={2000} required={contactForm.consentStatus === 'granted'} /></Field>
          <div className="outreach-form-actions outreach-field--wide"><button type="submit" className="button button--primary">{busy === 'contact' ? '저장 중…' : contactForm.id ? '연락처 수정 저장' : '연락처 등록'}</button></div>
        </fieldset>
      </form>
      <details className="outreach-csv"><summary>CSV로 여러 연락처 등록</summary>
        <p className="outreach-note">최대 {status.maxImportRows || 200}행 · 512,000바이트 이하 UTF-8 CSV를 선택하세요. 오류·기존 이메일 중복이 있으면 전체 등록을 취소합니다.</p>
        <p className="outreach-note">필수 열: <code>channelName,email,publicEmailSource</code>. 동의 확인은 <code>consentStatus=granted</code>와 근거·ISO 일시가 필요합니다.</p>
        <details><summary>사용 가능한 CSV 열 이름</summary><code className="outreach-csv-columns">{OUTREACH_CSV_COLUMNS.join(',')}</code><p className="outreach-note">분류: web_entertainment / actor / general. 국가: KR 또는 빈칸. koreaVerified: true / false. 날짜 예: 2026-10-11T01:00:00Z</p></details>
        <Field label="CSV 파일"><input type="file" accept=".csv,text/csv" onChange={selectCsv} disabled={!databaseReady || Boolean(busy)} /></Field>
        {csvError && <p className="outreach-alert outreach-alert--error" role="alert">{csvError}</p>}
        {csvPreview && <>
          <p role="status">{csvName} · {csvPreview.rows.length}행 · 확인 필요 {csvPreview.errorCount}행</p>
          <div className="outreach-table-wrap"><table className="outreach-table"><caption className="sr-only">CSV 등록 미리보기</caption><thead><tr><th scope="col">행</th><th scope="col">채널·이메일</th><th scope="col">동의</th><th scope="col">확인 결과</th></tr></thead>
            <tbody>{csvPreview.rows.map((row) => <tr key={row.line}><td>{row.line}</td><td>{row.contact.channelName}<small>{row.contact.email}</small></td><td>{row.contact.consentStatus === 'granted' ? '동의 확인' : row.contact.consentStatus === 'revoked' ? '철회' : '미확인'}</td><td>{row.errors.join(' · ') || '기본 형식 확인 · 서버 재검증'}</td></tr>)}</tbody>
          </table></div>
          <button type="button" className="button button--secondary" disabled={Boolean(busy) || !databaseReady || csvPreview.errorCount > 0} onClick={importCsv}>{busy === 'import' ? '등록 중…' : `${csvPreview.rows.length}개 연락처 등록`}</button>
        </>}
      </details>
    </section>

    <section className="outreach-panel" aria-labelledby="outreach-contacts-title">
      <div className="outreach-panel__heading"><h2 id="outreach-contacts-title">3. 발송 대상 선택</h2><span>{selectedContacts.size}개 선택 · 등록 {totalContacts}개</span></div>
      <p className="outreach-note">동의·국가·구독자·확인일 조건을 충족한 연락처를 캠페인당 최대 200개 선택할 수 있습니다. 최근 30일 발송·전송 확인 필요 주소 등은 서버에서 다시 제외합니다.</p>
      <form className="outreach-search outreach-search--contacts" onSubmit={(event) => { event.preventDefault(); setAppliedQuery(contactQuery.trim()); setContactPage(1); }}>
        <Field label="등록 연락처 검색"><input value={contactQuery} onChange={(event) => setContactQuery(event.target.value)} placeholder="채널명 또는 이메일" maxLength={200} /></Field>
        <button type="submit" className="button button--secondary" disabled={!databaseReady || contactsLoading}>연락처 검색</button>
        <button type="button" className="button button--secondary" disabled={!selectedContacts.size || Boolean(busy)} onClick={() => setSelectedContacts(new Set())}>선택 해제</button>
      </form>
      <div className="outreach-table-wrap" aria-busy={contactsLoading}><table className="outreach-table"><caption className="sr-only">등록 연락처와 발송 가능 여부</caption><thead><tr><th scope="col">선택</th><th scope="col">채널·이메일</th><th scope="col">발송 조건</th><th scope="col">관리</th></tr></thead>
        <tbody>{contacts.map((contact) => {
          const reason = contactEligibility(contact);
          return <tr key={contact.id}><td><input type="checkbox" aria-label={`${contact.channelName || '채널 정보 재확인 필요'} 발송 대상 선택`} checked={selectedContacts.has(contact.id)} disabled={Boolean(busy) || (!selectedContacts.has(contact.id) && (Boolean(reason) || selectedContacts.size >= 200))} onChange={(event) => { const checked = event.target.checked; setSelectedContacts((current) => { const next = new Set(current); if (checked) next.add(contact.id); else next.delete(contact.id); return next; }); }} /></td>
            <td>{contact.channelName || '채널 정보 재확인 필요'}<small>{contact.email}</small></td><td><span className={`outreach-badge${reason ? '' : ' is-ready'}`}>{reason || '발송 조건 확인'}</span><small>채널 확인: {displayDate(contact.channelCheckedAt)}</small></td>
            <td><div className="outreach-actions"><button type="button" className="button button--secondary" disabled={Boolean(busy)} onClick={() => editContact(contact)}>수정</button>
              {contact.metadataExpiredAt && contact.consentStatus !== 'revoked' && <button type="button" className="button button--secondary" disabled={Boolean(busy)} onClick={() => recordRevocation(contact)}>수신 동의 철회 기록</button>}</div></td></tr>;
        })}</tbody>
      </table></div>
      {!contacts.length && <p className="outreach-empty">{contactsLoading ? '연락처를 불러오고 있습니다.' : '등록된 연락처가 없습니다.'}</p>}
      <div className="outreach-pagination"><button type="button" className="button button--secondary" disabled={contactPage <= 1 || contactsLoading || !databaseReady} onClick={() => setContactPage((value) => value - 1)}>이전</button><span>{contactPage} / {Math.max(1, Math.ceil(totalContacts / 50))}</span><button type="button" className="button button--secondary" disabled={contactPage * 50 >= totalContacts || contactsLoading || !databaseReady} onClick={() => setContactPage((value) => value + 1)}>다음</button></div>
    </section>

    <section className="outreach-panel" aria-labelledby="outreach-compose-title">
      <h2 id="outreach-compose-title">4. 캠페인 문안 작성</h2>
      <p className="outreach-note">{'{{channelName}}'}은 각 채널명으로 바뀝니다. 광고 표시·발신자 정보·수신거부 안내는 서버에서 추가합니다.</p>
      <form onSubmit={saveCampaign}><fieldset className="outreach-fields" disabled={!databaseReady || Boolean(busy)}><legend className="sr-only">캠페인 초안</legend>
        <Field label="관리용 캠페인 이름" wide><input value={campaignForm.name} onChange={(event) => setCampaignForm((current) => ({ ...current, name: event.target.value }))} maxLength={120} placeholder="첫 소개 메일" required /></Field>
        <Field label="메일 제목" wide><input value={campaignForm.subject} onChange={(event) => setCampaignForm((current) => ({ ...current, subject: event.target.value }))} maxLength={175} required /></Field>
        <Field label="메일 본문" wide><textarea rows={12} value={campaignForm.body} onChange={(event) => setCampaignForm((current) => ({ ...current, body: event.target.value }))} maxLength={12000} required /></Field>
        <div className="outreach-form-actions outreach-field--wide"><span>선택 대상 {selectedContacts.size}개</span><button type="submit" className="button button--primary" disabled={!selectedContacts.size}>{busy === 'campaign' ? '저장 중…' : '캠페인 초안 저장'}</button></div>
      </fieldset></form>
    </section>

    <section className="outreach-panel" aria-labelledby="outreach-campaigns-title">
      <h2 id="outreach-campaigns-title">5. 미리보기와 발송 관리</h2>
      <div className="outreach-search outreach-search--contacts"><Field label="저장한 캠페인"><select value={campaignId} disabled={!databaseReady || Boolean(busy)} onChange={(event) => { setCampaignId(event.target.value); setCampaignDetail(null); }}><option value="">캠페인을 선택하세요</option>{campaigns.map((item) => <option key={item.id} value={item.id}>{item.name} · {CAMPAIGN_LABELS[item.status] || item.status}</option>)}</select></Field>
        <button type="button" className="button button--secondary" disabled={!databaseReady || Boolean(busy)} onClick={() => { setCampaignPage(1); setRefreshVersion((value) => value + 1); }}>목록·상태 새로고침</button></div>
      {campaigns.length < totalCampaigns && <button type="button" className="button button--secondary" disabled={contactsLoading || Boolean(busy)} onClick={() => setCampaignPage((value) => value + 1)}>이전 캠페인 더 보기 ({campaigns.length}/{totalCampaigns})</button>}
      {testMessage && <div className="outreach-preview" aria-live="polite">
        <h3>본인 테스트 메일 상태</h3><p>받는 사람: codemeet@naver.com</p>
        <p><span className={`outreach-badge${['failed', 'uncertain'].includes(testMessage.status) ? ' is-warning' : ''}`}>{MESSAGE_LABELS[testMessage.status] || testMessage.status}</span></p>
        {testMessage.errorCode && <DeliveryReason code={testMessage.errorCode} />}
        {testMessage.sentAt && <p className="outreach-note">메일 서버 접수 시각: {displayDate(testMessage.sentAt)}</p>}
        <p className="outreach-note">메일 서버 접수는 실제 수신을 보장하지 않습니다. 수신함에서 직접 확인해 주세요. 전송 확인 필요 건은 자동 재발송하지 않습니다.</p>
        {!FINAL_MESSAGE_STATUSES.has(testMessage.status) && <p className="outreach-note">화면이 보이는 동안 10초마다 상태를 확인합니다.</p>}
        {testMessageError && <p className="outreach-alert outreach-alert--error" role="alert">테스트 상태 확인: {testMessageError}</p>}
      </div>}
      {campaign && <>
        <div className="outreach-panel__heading"><h3>{campaign.name}</h3><span className="outreach-badge">{CAMPAIGN_LABELS[campaign.status] || campaign.status}</span></div>
        <p className="outreach-note">생성: {displayDate(campaign.createdAt)}{campaign.scheduledAt ? ` · 예약: ${displayDate(campaign.scheduledAt)}` : ''}. 발송 상태는 10초마다 갱신됩니다.</p>
        <p className="outreach-note">대기열에 저장한 문안은 고정됩니다. 문안을 바꾸려면 새 캠페인을 작성하세요.</p>
        <div className="outreach-actions"><button type="button" className="button button--secondary" disabled={Boolean(busy) || campaign.status !== 'draft'} onClick={previewCampaign}>{busy === 'preview' ? '확인 중…' : '문안·발송 대상 미리보기'}</button>
          <button type="button" className="button button--secondary" disabled={Boolean(busy)} onClick={() => { setCampaignForm({ name: `${campaign.name} 복사`, subject: campaign.subject, body: campaign.body }); setSuccess('문안을 새 캠페인 작성란에 복사했습니다. 대상은 다시 확인해 주세요.'); }}>문안을 새 작성란에 복사</button></div>
        {activePreview && <div className="outreach-preview">
          <h3>발송 전 미리보기</h3><p>발송 가능 {activePreview.eligibleCount}개 · 제외 {activePreview.excluded?.length || 0}개</p>
          {activePreview.excluded?.length > 0 && <ul className="outreach-exclusions">{activePreview.excluded.map((excluded, index) => <li key={`${excluded.contactId}-${index}`}>{contacts.find(({ id }) => id === excluded.contactId)?.channelName || '선택한 연락처'}<DeliveryReason code={excluded.reason} /></li>)}</ul>}
          {activePreview.samples?.length > 0 && <Field label="개별 문안 확인"><select value={sample?.contactId || ''} onChange={(event) => setSampleId(event.target.value)}>{activePreview.samples.map((item) => <option key={item.contactId} value={item.contactId}>{item.channelName || '채널 정보 재확인 필요'} · {item.to}</option>)}</select></Field>}
          {sample && <p className="outreach-note">받는 사람: {sample.to}</p>}
          <h4>{sample?.subject || activePreview.subject}</h4><pre>{sample?.body || activePreview.body}</pre>
          {!status.publicUrlConfigured && <p className="outreach-note">수신거부 링크는 미리보기용 표시입니다. 실제 발송 전 설정이 필요합니다.</p>}
          <button type="button" className="button button--secondary" disabled={!canSend || Boolean(busy)} onClick={testSend}>{busy === 'test' ? '접수 중…' : '본인에게 테스트 메일 보내기 (codemeet@naver.com)'}</button>
          {campaign.status === 'draft' && <div className="outreach-queue">
            <Field label="대기열 저장 방식"><select value={queueMode} disabled={Boolean(busy)} onChange={(event) => setQueueMode(event.target.value)}><option value="manual">저장 후 직접 발송 시작</option><option value="scheduled">시각을 정해 예약 발송</option></select></Field>
            {queueMode === 'scheduled' && <Field label="예약 시각 (기기 현지 시간)"><input type="datetime-local" value={schedule} onChange={(event) => setSchedule(event.target.value)} disabled={Boolean(busy)} required /></Field>}
            <p className="outreach-note">{queueMode === 'scheduled' ? '예약 시각부터 순차 발송합니다.' : '대기열에 저장한 뒤 순차 발송 시작 버튼을 눌러야 발송됩니다.'}</p>
            <button type="button" className="button button--primary" disabled={Boolean(busy) || !activePreview.eligibleCount || (queueMode === 'scheduled' && (!canSend || !schedule))} onClick={queueCampaign}>{busy === 'queue' ? '저장 중…' : queueMode === 'scheduled' ? '예약 발송 등록' : '발송 대기열에 저장'}</button>
          </div>}
        </div>}
        <div className="outreach-actions">
          {['queued', 'paused'].includes(campaign.status) && <button type="button" className="button button--primary" disabled={!canSend || Boolean(busy)} onClick={() => changeCampaignState('start')}>{campaign.status === 'paused' ? '순차 발송 재개' : '순차 발송 시작'}</button>}
          {['queued', 'running'].includes(campaign.status) && <button type="button" className="button button--secondary" disabled={Boolean(busy)} onClick={() => changeCampaignState('pause')}>발송 일시정지</button>}
        </div>
        <p className="outreach-note">‘메일 서버 접수’는 SMTP 접수 상태이며 실제 수신을 보장하지 않습니다. ‘전송 확인 필요’ 건은 자동 재발송하지 않습니다.</p>
        {campaign.counts && <div className="outreach-counts">{Object.entries(MESSAGE_LABELS).map(([key, label]) => <span key={key}>{label} <strong>{campaign.counts[key] || 0}</strong></span>)}</div>}
        <div className="outreach-table-wrap"><table className="outreach-table"><caption className="sr-only">캠페인 최근 메일 상태 최대 200건</caption><thead><tr><th scope="col">채널·이메일</th><th scope="col">상태</th><th scope="col">접수 시각</th></tr></thead><tbody>
          {campaignDetail.messages?.map((message) => <tr key={message.id}><td>{message.channelName || '채널 정보 재확인 필요'}<small>{message.email}</small></td><td><span className={`outreach-badge${message.status === 'uncertain' || message.status === 'failed' ? ' is-warning' : ''}`}>{MESSAGE_LABELS[message.status] || message.status}</span>{message.errorCode && <DeliveryReason code={message.errorCode} />}</td><td>{message.sentAt ? displayDate(message.sentAt) : '—'}</td></tr>)}
        </tbody></table></div>
        {!campaignDetail.messages?.length && <p className="outreach-empty">아직 대기열에 저장한 메일이 없습니다.</p>}
        {campaignDetail.totalMessages > 200 && <p className="outreach-note">최근 200건을 표시합니다. 전체 {campaignDetail.totalMessages}건의 상태 합계는 위에서 확인하세요.</p>}
      </>}
      {!campaignId && <p className="outreach-empty">캠페인 초안을 저장한 뒤 문안과 대상을 확인하세요.</p>}
    </section>
  </div>;
}
