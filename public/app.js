const grid = document.querySelector('#candidate-grid');
const search = document.querySelector('#search');
const dialog = document.querySelector('#vote-dialog');
const signIn = document.querySelector('#sign-in');
const loginState = document.querySelector('#login-state');
const adminControls = document.querySelector('#admin-voting-controls');
const adminMessage = document.querySelector('#admin-voting-message');
const candidateForm = document.querySelector('#candidate-form');
const candidateFormMessage = document.querySelector('#admin-candidates');
const candidateMessage = document.querySelector('#candidate-message');
const navLinks = [...document.querySelectorAll('.topbar nav a')];
let candidates = [];
let selectedCandidate = null;
let candidateCropImage = null;
let candidateCropZoom = 1;
let candidateCropOffset = { x: 0, y: 0 };
let candidateCropDrag = null;
let candidateCropChanged = false;
let electionStatus = { electionOpen: false, authenticated: false, hasVoted: false, isAdmin: false };
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function formatSchedule(value) {
  if (!value) return 'ยังไม่กำหนด';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'ยังไม่กำหนด' : date.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}

function toLocalDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function updateActiveNav() {
  const activeLink = navLinks.find(link => link.hash === window.location.hash) || navLinks[0];
  navLinks.forEach(link => link.classList.toggle('active', link === activeLink));
}

function selectAdminTab(tabName, focusTab = false) {
  const tabs = [...adminControls.querySelectorAll('[data-admin-tab]')];
  const panels = [...adminControls.querySelectorAll('[data-admin-panel]')];
  const selectedTab = tabs.find(tab => tab.dataset.adminTab === tabName) || tabs[0];
  tabs.forEach(tab => {
    const selected = tab === selectedTab;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  panels.forEach(panel => {
    panel.hidden = panel.dataset.adminPanel !== selectedTab.dataset.adminTab;
  });
  if (focusTab) selectedTab.focus();
}

async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) throw new Error(`Status request failed: ${r.status}`);
    const s = await r.json();
    electionStatus = s;
    document.querySelector('#election-state').textContent = s.electionOpen ? 'เปิดรับคะแนนใน Roblox' : 'ปิดรับคะแนนเพื่อความปลอดภัย';
    document.querySelector('#results-term-name').textContent = s.electionTerm?.name || 'สมัยการเลือกตั้ง';
    const dateLabels = document.querySelectorAll('.dates b');
    dateLabels[0].textContent = formatSchedule(s.votingStartsAt);
    dateLabels[1].textContent = formatSchedule(s.votingEndsAt);
    loginState.textContent = s.authenticated ? `Discord: ${s.user.displayName}` : 'ยังไม่ได้เข้าสู่ระบบ';
    document.querySelector('#player-name').firstChild.textContent = s.authenticated ? s.user.displayName : 'ผู้เยี่ยมชม';
    const avatar = document.querySelector('#player-avatar');
    if (s.authenticated && s.user.avatarUrl) {
      avatar.src = s.user.avatarUrl;
      avatar.alt = `รูปโปรไฟล์ Discord ของ ${s.user.displayName}`;
      avatar.hidden = false;
    } else {
      avatar.removeAttribute('src');
      avatar.alt = '';
      avatar.hidden = true;
    }
    signIn.disabled = !s.authenticated && !s.authReady;
    signIn.textContent = s.authenticated ? 'ออกจากระบบ Discord' : 'ลงทะเบียน / เข้าสู่ระบบ Discord';
    signIn.dataset.authenticated = String(s.authenticated);
    adminControls.hidden = !s.isAdmin;
    if (s.isAdmin && adminControls.dataset.initialized !== 'true') {
      selectAdminTab('overview');
      document.querySelector('#schedule-start').value = toLocalDateTime(s.votingStartsAt);
      document.querySelector('#schedule-end').value = toLocalDateTime(s.votingEndsAt);
      document.querySelector('#admin-current-term').textContent = s.electionTerm?.name || 'ไม่ระบุ';
      document.querySelector('#election-term-name').textContent = s.electionTerm?.name || 'ไม่ระบุ';
      adminControls.dataset.initialized = 'true';
      loadAdminData();
    }
    renderCandidates();
  } catch (error) {
    console.error(error);
    document.querySelector('#election-state').textContent = 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์';
  }
}
adminControls.querySelector('.admin-menu').addEventListener('click', event => {
  const tab = event.target.closest('[data-admin-tab]');
  if (tab) selectAdminTab(tab.dataset.adminTab);
});
adminControls.querySelector('.admin-menu').addEventListener('keydown', event => {
  const tabs = [...adminControls.querySelectorAll('[data-admin-tab]')];
  const currentIndex = tabs.indexOf(document.activeElement);
  if (currentIndex < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const nextIndex = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
      : (currentIndex + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
  selectAdminTab(tabs[nextIndex].dataset.adminTab, true);
});
async function loadCandidates() {
  try { const r = await fetch('/api/candidates'); candidates = await r.json(); renderCandidates(); }
  catch { grid.innerHTML = '<p>ไม่สามารถโหลดข้อมูลผู้สมัครได้ กรุณาลองใหม่ภายหลัง</p>'; }
}
function renderCandidates() {
  const q = search.value.trim().toLowerCase();
  const filtered = candidates.filter(c => `${c.name} ${c.party} ${c.number}`.toLowerCase().includes(q));
  const canVote = electionStatus.electionOpen && electionStatus.authenticated && !electionStatus.hasVoted;
  const voteTitle = electionStatus.hasVoted
    ? 'บัญชีนี้ลงคะแนนแล้ว'
    : !electionStatus.electionOpen
      ? 'ยังไม่เปิดลงคะแนน'
      : !electionStatus.authenticated
        ? 'กรุณาเข้าสู่ระบบ Discord ก่อนลงคะแนน'
        : '';
  grid.innerHTML = filtered.map(c => `<article class="candidate" style="--c:${esc(c.color)};--tie:${esc(c.color)};--hair:${c.number===2?'#5c2424':c.number===4?'#c4c6c9':c.number===3?'#191d24':'#151b25'}">
    <div class="portrait" data-number="${c.number}">${c.imageUrl ? `<img class="candidate-photo" src="${esc(c.imageUrl)}" alt="รูปผู้สมัคร ${esc(c.name)}" loading="lazy">` : '<div class="person"><span class="tie"></span></div>'}<span class="candidate-number">หมายเลข<strong>${c.number}</strong></span></div>
    <div class="candidate-info"><p class="party">${esc(c.party)}</p><div class="role">ผู้สมัครนายกรัฐมนตรี</div><p class="name">${esc(c.name)}</p><p class="slogan">“${esc(c.slogan)}”</p><button class="vote-button" data-candidate-id="${c.id}" ${canVote ? '' : 'disabled'} title="${esc(voteTitle)}">${canVote ? 'ลงคะแนนเสียง' : '🔒 ลงคะแนนเสียง'}</button></div></article>`).join('') || '<p>ไม่พบผู้สมัครที่ตรงกับคำค้นหา</p>';
}
async function loadResults() {
  try {
    const r = await fetch('/api/results'); const data = await r.json();
    if (!r.ok) throw new Error(data.error || `โหลดผลคะแนนไม่สำเร็จ (${r.status})`);
    document.querySelector('#total-votes').textContent = data.totalVotes;
    document.querySelector('#results-term-name').textContent = data.electionTerm?.name || 'สมัยการเลือกตั้ง';
    document.querySelector('#results-list').innerHTML = data.results.map(x => `<div class="result-item"><b>${esc(x.number)}. ${esc(x.party)}</b><strong>${x.votes}</strong><div class="role">คะแนนเสียง</div></div>`).join('');
    if (!data.results.length) document.querySelector('#results-list').textContent = 'ยังไม่มีผู้สมัครหรือคะแนน';
  } catch { document.querySelector('#results-list').textContent = 'ไม่สามารถโหลดผลคะแนนได้'; }
}
async function loadSiteContent() {
  try {
    const response = await fetch('/api/site-content');
    const content = await response.json();
    if (!response.ok) throw new Error(content.error || `โหลดเนื้อหาไม่สำเร็จ (${response.status})`);
    document.title = `${content.heroTitle} | ${content.eventName}`;
    document.querySelector('#brand-title').textContent = content.heroTitle;
    document.querySelector('#brand-event-name').textContent = content.eventName;
    document.querySelector('#event-name').textContent = `${content.eventName.toUpperCase()} • ROBLOX`;
    document.querySelector('#hero-title').textContent = content.heroTitle;
    document.querySelector('#hero-subtitle').textContent = content.heroSubtitle;
    document.querySelector('#hero-description').textContent = content.heroDescription;
    document.querySelector('#site-notice').textContent = content.notice;
    document.querySelector('#results-event-name').textContent = content.eventName;
    document.querySelector('#footer-event-name').textContent = content.eventName;
    document.querySelector('#footer-slogan').textContent = content.footerSlogan;
  } catch (error) {
    console.error(error);
  }
}
async function adminRequest(url, method = 'GET', body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  const responseText = await response.text();
  let payload;
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    if (response.status === 404) {
      throw new Error('ไม่พบ API สำหรับจัดการผู้สมัคร กรุณารีเฟรชหน้าเว็บและตรวจว่าเซิร์ฟเวอร์ใช้โค้ดล่าสุด');
    }
    throw new Error(`เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (${response.status})`);
  }
  if (!response.ok) throw new Error(payload.error || `ดำเนินการไม่สำเร็จ (${response.status})`);
  return payload;
}
function setCandidateForm(candidate) {
  candidateForm.reset();
  document.querySelector('#candidate-id').value = candidate?.id || '';
  document.querySelector('#candidate-active').value = String(candidate ? Boolean(candidate.active) : true);
  document.querySelector('#candidate-number').value = candidate?.number || '';
  document.querySelector('#candidate-name').value = candidate?.name || '';
  document.querySelector('#candidate-party').value = candidate?.party || '';
  document.querySelector('#candidate-slogan').value = candidate?.slogan || '';
  document.querySelector('#candidate-color').value = candidate?.color || '#2563eb';
  document.querySelector('#candidate-image').value = '';
  document.querySelector('#remove-candidate-image').checked = false;
  document.querySelector('#remove-candidate-image-label').hidden = !candidate?.imageUrl;
  candidateCropImage = null;
  candidateCropZoom = 1;
  candidateCropOffset = { x: 0, y: 0 };
  candidateCropChanged = false;
  document.querySelector('#candidate-image-zoom').value = '1';
  const imagePreview = document.querySelector('#candidate-image-preview');
  imagePreview.hidden = true;
  if (candidate?.imageUrl) {
    const image = new Image();
    image.onload = () => {
      if (document.querySelector('#candidate-id').value !== String(candidate.id)) return;
      candidateCropImage = image;
      drawCandidateCrop();
      imagePreview.hidden = false;
    };
    image.onerror = () => {
      candidateMessage.textContent = 'โหลดรูปผู้สมัครเดิมไม่สำเร็จ';
    };
    image.src = candidate.imageUrl;
  }
  document.querySelector('#save-candidate').textContent = candidate ? 'บันทึกการแก้ไข' : 'เพิ่มผู้สมัคร';
  document.querySelector('#cancel-candidate-edit').hidden = !candidate;
}
function renderAdminCandidates(rows) {
  candidateFormMessage.innerHTML = rows.map(candidate => `<article class="admin-candidate">
    <div><b>${esc(candidate.number)}. ${esc(candidate.name)}</b><span>${esc(candidate.party)} · สมัยนี้ ${candidate.votes} คะแนน · ${candidate.active ? 'ใช้งาน' : 'ปิดใช้งาน'}</span></div>
    <div class="admin-candidate-actions">
      <button type="button" class="secondary" data-edit-candidate="${candidate.id}" ${candidate.hasVotes ? 'disabled title="ผู้สมัครที่เคยมีคะแนนแล้วแก้ไขข้อมูลไม่ได้"' : ''}>แก้ไข</button>
      <button type="button" class="secondary" data-toggle-candidate="${candidate.id}" data-active="${candidate.active}">${candidate.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}</button>
      <button type="button" class="secondary danger" data-delete-candidate="${candidate.id}" ${candidate.hasVotes && !candidate.active ? 'disabled title="ปิดใช้งานแล้วและเก็บประวัติคะแนนไว้แล้ว"' : ''}>${candidate.hasVotes && !candidate.active ? 'เก็บประวัติแล้ว' : 'ลบ'}</button>
    </div>
  </article>`).join('') || '<p>ยังไม่มีข้อมูลผู้สมัคร เพิ่มผู้สมัครก่อนเปิดรับคะแนน</p>';
}
async function loadAdminData() {
  try {
    const [overview, candidates, content] = await Promise.all([
      adminRequest('/api/admin/overview'),
      adminRequest('/api/admin/candidates'),
      adminRequest('/api/admin/site-content')
    ]);
    document.querySelector('#admin-stats').innerHTML = `
      <div><b>${overview.totalVotes}</b><span>คะแนนที่บันทึก</span></div>
      <div><b>${overview.activeCandidates}</b><span>ผู้สมัครที่ใช้งาน</span></div>
      <div><b>${overview.registeredVoters}</b><span>บัญชี Discord ที่ลงทะเบียน</span></div>`;
    document.querySelector('#admin-current-term').textContent = overview.electionTerm?.name || 'ไม่ระบุ';
    document.querySelector('#election-term-name').textContent = overview.electionTerm?.name || 'ไม่ระบุ';
    renderAdminCandidates(candidates);
    for (const [key, value] of Object.entries(content)) {
      const field = document.querySelector(`#site-content-form [name="${key}"]`);
      if (field) field.value = value;
    }
    document.querySelector('#admin-audit').innerHTML = overview.recentEvents.map(event => `
      <div class="audit-row"><b>${esc(event.event)}</b><span>${esc(event.detail)}</span><time>${formatSchedule(event.created_at)}</time></div>`).join('')
      || '<p>ยังไม่มีรายการกิจกรรม</p>';
  } catch (error) {
    console.error(error);
    adminMessage.textContent = error.message || 'โหลดข้อมูลแอดมินไม่สำเร็จ';
  }
}
async function updateElectionSettings(payload) {
  const controls = [...adminControls.querySelectorAll('button,input')];
  controls.forEach(control => { control.disabled = true; });
  adminMessage.textContent = 'กำลังบันทึกการตั้งค่า…';
  try {
    const response = await fetch('/api/admin/election', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `บันทึกไม่สำเร็จ (${response.status})`);
    adminMessage.textContent = payload.mode === 'scheduled'
      ? 'บันทึกกำหนดเวลาเรียบร้อย ระบบจะเปิดและปิดคะแนนตามเวลาที่ตั้งไว้'
      : payload.open ? 'เปิดรับคะแนนแล้ว' : 'ปิดรับคะแนนแล้ว';
    adminControls.dataset.initialized = '';
    await loadStatus();
  } catch (error) {
    console.error(error);
    adminMessage.textContent = error.message || 'บันทึกการตั้งค่าไม่สำเร็จ';
  } finally {
    controls.forEach(control => { control.disabled = false; });
  }
}

async function castVote() {
  if (!selectedCandidate) return;
  const confirmButton = document.querySelector('#confirm-vote');
  const message = document.querySelector('#vote-message');
  confirmButton.disabled = true;
  message.textContent = 'กำลังบันทึกคะแนน…';
  try {
    const response = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId: selectedCandidate.id })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `ลงคะแนนไม่สำเร็จ (${response.status})`);
    message.textContent = result.message;
    await Promise.all([loadStatus(), loadResults()]);
  } catch (error) {
    console.error(error);
    message.textContent = error.message || 'ลงคะแนนไม่สำเร็จ กรุณาลองใหม่';
    confirmButton.disabled = false;
  }
}

search.addEventListener('input', renderCandidates);
grid.addEventListener('click', event => {
  const button = event.target.closest('button[data-candidate-id]');
  if (!button || button.disabled) return;
  selectedCandidate = candidates.find(candidate => candidate.id === Number(button.dataset.candidateId));
  if (!selectedCandidate) return;
  document.querySelector('#confirm-copy').textContent = `คุณเลือก ${selectedCandidate.name} (${selectedCandidate.party})`;
  document.querySelector('#vote-message').textContent = '';
  document.querySelector('#confirm-vote').disabled = false;
  dialog.showModal();
});
dialog.querySelector('form').addEventListener('submit', event => {
  if (event.submitter?.id !== 'confirm-vote') return;
  event.preventDefault();
  castVote();
});
document.querySelector('#open-voting').addEventListener('click', () => updateElectionSettings({ mode: 'manual', open: true }));
document.querySelector('#close-voting').addEventListener('click', () => updateElectionSettings({ mode: 'manual', open: false }));
document.querySelector('#schedule-form').addEventListener('submit', event => {
  event.preventDefault();
  const startsAt = document.querySelector('#schedule-start').value;
  const endsAt = document.querySelector('#schedule-end').value;
  if (!startsAt || !endsAt) return;
  updateElectionSettings({
    mode: 'scheduled',
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString()
  });
});
document.querySelector('#term-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = document.querySelector('#new-term-name').value.trim();
  if (!name || !window.confirm(`เริ่ม "${name}" เป็นสมัยการเลือกตั้งใหม่ใช่หรือไม่? คะแนนเดิมจะถูกเก็บแยกตามสมัย`)) return;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await adminRequest('/api/admin/terms', 'POST', { name });
    document.querySelector('#new-term-name').value = '';
    document.querySelector('#admin-current-term').textContent = result.term.name;
    document.querySelector('#election-term-name').textContent = result.term.name;
    adminControls.dataset.initialized = '';
    adminMessage.textContent = `เริ่มสมัยการเลือกตั้ง "${result.term.name}" แล้ว การลงคะแนนถูกปิดไว้`;
    await Promise.all([loadStatus(), loadResults(), loadAdminData()]);
  } catch (error) {
    adminMessage.textContent = error.message || 'เริ่มสมัยการเลือกตั้งใหม่ไม่สำเร็จ';
  } finally {
    button.disabled = false;
  }
});
candidateForm.addEventListener('submit', async event => {
  event.preventDefault();
  candidateMessage.textContent = '';
  const id = document.querySelector('#candidate-id').value;
  const payload = {
    number: Number(document.querySelector('#candidate-number').value),
    name: document.querySelector('#candidate-name').value,
    party: document.querySelector('#candidate-party').value,
    slogan: document.querySelector('#candidate-slogan').value,
    color: document.querySelector('#candidate-color').value
  };
  if (!Number.isInteger(payload.number) || payload.number < 1 || payload.number > 9999
    || !payload.name.trim() || !payload.party.trim() || !/^#[0-9a-f]{6}$/i.test(payload.color)) {
    candidateMessage.textContent = 'กรุณากรอกหมายเลข ชื่อผู้สมัคร กลุ่ม/พรรค และสีให้ถูกต้อง';
    return;
  }
  const submitButton = document.querySelector('#save-candidate');
  submitButton.disabled = true;
  try {
    const imageFile = document.querySelector('#candidate-image').files[0];
    if (imageFile) payload.imageData = await readCandidateImage(imageFile);
    else if (candidateCropChanged && candidateCropImage) payload.imageData = encodeCandidateCrop(candidateCropImage);
    if (document.querySelector('#remove-candidate-image').checked) payload.removeImage = true;
    await adminRequest(id ? `/api/admin/candidates/${id}` : '/api/admin/candidates', id ? 'PUT' : 'POST',
      id ? { ...payload, active: document.querySelector('#candidate-active').value === 'true' } : payload);
    setCandidateForm(null);
    candidateMessage.textContent = id ? 'บันทึกข้อมูลผู้สมัครแล้ว' : 'เพิ่มผู้สมัครแล้ว';
    await Promise.all([loadAdminData(), loadCandidates(), loadResults()]);
  } catch (error) {
    console.error(error);
    candidateMessage.textContent = error.message || 'บันทึกข้อมูลผู้สมัครไม่สำเร็จ';
  } finally {
    submitButton.disabled = false;
  }
});
function readCandidateImage(file) {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) return Promise.reject(new Error('เลือกรูป JPG, PNG หรือ WebP เท่านั้น'));
  if (file.size > 10 * 1024 * 1024) return Promise.reject(new Error('ไฟล์รูปต้นฉบับต้องไม่เกิน 10 MB'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ'));
    reader.onload = () => {
      const source = new Image();
      source.onerror = () => reject(new Error('ไฟล์นี้ไม่ใช่รูปภาพที่อ่านได้'));
      source.onload = () => {
        try {
          resolve(encodeCandidateCrop(source));
        } catch (error) {
          reject(error);
        }
      };
      source.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
document.querySelector('#cancel-candidate-edit').addEventListener('click', () => setCandidateForm(null));
document.querySelector('#candidate-image').addEventListener('change', event => {
  const file = event.currentTarget.files[0];
  const preview = document.querySelector('#candidate-image-preview');
  if (!file) return;
  candidateCropImage = null;
  candidateCropZoom = 1;
  candidateCropOffset = { x: 0, y: 0 };
  candidateCropChanged = false;
  document.querySelector('#candidate-image-zoom').value = '1';
  preview.hidden = true;
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      candidateCropImage = image;
      candidateCropZoom = 1;
      candidateCropOffset = { x: 0, y: 0 };
      candidateCropChanged = false;
      document.querySelector('#candidate-image-zoom').value = '1';
      drawCandidateCrop();
      preview.hidden = false;
      document.querySelector('#remove-candidate-image').checked = false;
    };
    image.onerror = () => {
      candidateMessage.textContent = 'ไฟล์นี้ไม่ใช่รูปภาพที่อ่านได้';
    };
    image.src = reader.result;
  };
  reader.onerror = () => {
    candidateMessage.textContent = 'อ่านไฟล์รูปภาพไม่สำเร็จ';
  };
  reader.readAsDataURL(file);
});
function getCandidateCrop(image, width, height) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight) * candidateCropZoom;
  const previewScale = Math.max(320 / image.naturalWidth, 240 / image.naturalHeight) * candidateCropZoom;
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  const centerX = image.naturalWidth / 2 - candidateCropOffset.x / previewScale;
  const centerY = image.naturalHeight / 2 - candidateCropOffset.y / previewScale;
  return {
    x: Math.max(0, Math.min(image.naturalWidth - cropWidth, centerX - cropWidth / 2)),
    y: Math.max(0, Math.min(image.naturalHeight - cropHeight, centerY - cropHeight / 2)),
    width: cropWidth,
    height: cropHeight
  };
}
function encodeCandidateCrop(image) {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 900;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('ไม่สามารถเตรียมรูปสำหรับครอปได้');
  const crop = getCandidateCrop(image, canvas.width, canvas.height);
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  let quality = 0.88;
  let data = canvas.toDataURL('image/jpeg', quality);
  while (data.length * 0.75 > 1.5 * 1024 * 1024 && quality > 0.5) {
    quality -= 0.1;
    data = canvas.toDataURL('image/jpeg', quality);
  }
  if (data.length * 0.75 > 1.5 * 1024 * 1024) throw new Error('รูปภาพมีขนาดใหญ่เกินไปหลังปรับขนาด');
  return data;
}
function drawCandidateCrop() {
  if (!candidateCropImage) return;
  const canvas = document.querySelector('#candidate-image-crop');
  const context = canvas.getContext('2d');
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  const scale = Math.max(width / candidateCropImage.naturalWidth, height / candidateCropImage.naturalHeight) * candidateCropZoom;
  const imageWidth = candidateCropImage.naturalWidth * scale;
  const imageHeight = candidateCropImage.naturalHeight * scale;
  const maxOffsetX = Math.max(0, (imageWidth - width) / 2);
  const maxOffsetY = Math.max(0, (imageHeight - height) / 2);
  candidateCropOffset.x = Math.max(-maxOffsetX, Math.min(maxOffsetX, candidateCropOffset.x));
  candidateCropOffset.y = Math.max(-maxOffsetY, Math.min(maxOffsetY, candidateCropOffset.y));
  context.clearRect(0, 0, width, height);
  context.drawImage(candidateCropImage,
    (width - imageWidth) / 2 + candidateCropOffset.x,
    (height - imageHeight) / 2 + candidateCropOffset.y,
    imageWidth, imageHeight);
}
document.querySelector('#candidate-image-zoom').addEventListener('input', event => {
  candidateCropZoom = Number(event.currentTarget.value);
  candidateCropChanged = true;
  drawCandidateCrop();
});
const cropCanvas = document.querySelector('#candidate-image-crop');
cropCanvas.addEventListener('pointerdown', event => {
  if (!candidateCropImage) return;
  cropCanvas.setPointerCapture(event.pointerId);
  const bounds = cropCanvas.getBoundingClientRect();
  candidateCropDrag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    offsetX: candidateCropOffset.x,
    offsetY: candidateCropOffset.y,
    scaleX: cropCanvas.width / bounds.width,
    scaleY: cropCanvas.height / bounds.height
  };
});
cropCanvas.addEventListener('pointermove', event => {
  if (!candidateCropDrag || candidateCropDrag.pointerId !== event.pointerId) return;
  candidateCropOffset = {
    x: candidateCropDrag.offsetX + (event.clientX - candidateCropDrag.x) * candidateCropDrag.scaleX,
    y: candidateCropDrag.offsetY + (event.clientY - candidateCropDrag.y) * candidateCropDrag.scaleY
  };
  candidateCropChanged = true;
  drawCandidateCrop();
});
const stopCandidateCropDrag = event => {
  if (candidateCropDrag?.pointerId === event.pointerId) candidateCropDrag = null;
};
cropCanvas.addEventListener('pointerup', stopCandidateCropDrag);
cropCanvas.addEventListener('pointercancel', stopCandidateCropDrag);
candidateFormMessage.addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit-candidate]');
  const toggle = event.target.closest('[data-toggle-candidate]');
  const deleteButton = event.target.closest('[data-delete-candidate]');
  try {
    if (edit) {
      const rows = await adminRequest('/api/admin/candidates');
      setCandidateForm(rows.find(row => row.id === Number(edit.dataset.editCandidate)));
      return;
    }
    if (deleteButton) {
      const rows = await adminRequest('/api/admin/candidates');
      const candidate = rows.find(row => row.id === Number(deleteButton.dataset.deleteCandidate));
      if (!candidate) throw new Error('ไม่พบผู้สมัคร');
      const confirmation = candidate.hasVotes
        ? `ผู้สมัคร ${candidate.name} มีคะแนนในประวัติ ระบบจะปิดใช้งานแทนการลบเพื่อเก็บผลคะแนน ต้องการดำเนินการหรือไม่?`
        : `ยืนยันลบผู้สมัคร ${candidate.name} ใช่หรือไม่?`;
      if (!window.confirm(confirmation)) return;
      const result = await adminRequest(`/api/admin/candidates/${candidate.id}`, 'DELETE');
      candidateMessage.textContent = result.message;
      await Promise.all([loadAdminData(), loadCandidates(), loadResults()]);
      return;
    }
    if (toggle) {
      const rows = await adminRequest('/api/admin/candidates');
      const candidate = rows.find(row => row.id === Number(toggle.dataset.toggleCandidate));
      if (!candidate) throw new Error('ไม่พบผู้สมัคร');
      await adminRequest(`/api/admin/candidates/${candidate.id}`, 'PUT', {
        number: candidate.number, name: candidate.name, party: candidate.party,
        slogan: candidate.slogan, color: candidate.color, active: !candidate.active
      });
      adminMessage.textContent = candidate.active ? 'ปิดใช้งานผู้สมัครแล้ว' : 'เปิดใช้งานผู้สมัครแล้ว';
      await Promise.all([loadAdminData(), loadCandidates(), loadResults()]);
    }
  } catch (error) {
    candidateMessage.textContent = error.message || 'จัดการผู้สมัครไม่สำเร็จ';
  }
});
document.querySelector('#site-content-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const content = Object.fromEntries(new FormData(form).entries());
  try {
    await adminRequest('/api/admin/site-content', 'PUT', content);
    adminMessage.textContent = 'บันทึกเนื้อหาหน้าเว็บแล้ว';
    await Promise.all([loadSiteContent(), loadAdminData()]);
  } catch (error) {
    adminMessage.textContent = error.message || 'บันทึกเนื้อหาหน้าเว็บไม่สำเร็จ';
  }
});
navLinks.forEach(link => link.addEventListener('click', updateActiveNav));
window.addEventListener('hashchange', updateActiveNav);
signIn.addEventListener('click', async () => {
  if (signIn.dataset.authenticated !== 'true') {
    window.location.assign('/auth/discord');
    return;
  }
  signIn.disabled = true;
  try {
    const response = await fetch('/auth/logout', { method: 'POST' });
    if (!response.ok) throw new Error(`Logout failed: ${response.status}`);
    window.location.reload();
  } catch (error) {
    console.error(error);
    loginState.textContent = 'ออกจากระบบไม่สำเร็จ กรุณาลองใหม่';
    signIn.disabled = false;
  }
});
updateActiveNav();
loadStatus(); loadCandidates(); loadResults(); loadSiteContent();
window.setInterval(loadStatus, 30000);
window.setInterval(loadResults, 30000);
