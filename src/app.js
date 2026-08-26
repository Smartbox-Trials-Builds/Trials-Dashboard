import { createClient } from '@supabase/supabase-js';
import './styles.css';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || localStorage.getItem('supabaseUrl') || '';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || localStorage.getItem('supabaseAnonKey') || '';

const laneNames = ['Expedites', 'Funded Rentals', 'Ship Requested', 'Accessories', 'Daily Queue'];
const roles = ['Admin', 'Lead', 'Device Coordinator', 'Shipper', 'Device Systems Specialist'];
const trainedDeviceOptions = ["Wego's", "Talk Pad's", "Grid Pad's", "Zuvo's"];
const newHireClaimWindowMs = 10000;
const userManagerRoles = ['Admin', 'Lead'];
const profileRoles = ['Lead', 'Device Coordinator', 'Device Systems Specialist'];
const roleViews = {
  Admin: ['leadDashboard', 'dashboard', 'preprep', 'shipping', 'users'],
  Lead: ['leadDashboard', 'dashboard', 'preprep', 'shipping', 'users', 'profile'],
  'Device Systems Specialist': ['dashboard', 'preprep', 'shipping', 'profile'],
  Shipper: ['shipping'],
  'Device Coordinator': ['dashboard', 'profile']
};
const statusSteps = {
  'Ready for Pre-Prep': 'Ready for Prep',
  Complete: 'Shipped'
};

let supabase = null;
let files = [];
let gipodCodes = [];
let users = [];
let specialists = [];
let coordinators = [];
let shipmentHistory = [];
let eodCleanups = [];
let teamActivity = [];
let selectedProfileId = '';
let profileUser = null;
let profileActivity = [];
let profileSidekickLogs = [];
let fileLogs = [];
let activeFileTab = 'details';
let view = 'dashboard';
let prepTab = 'files';
let codeTab = 'unused';
let leadTab = 'schedules';
let prepperFilter = 'All';
let selectedFileIds = new Set();
let activePrepNotifications = new Map();
let seenPrepNotifications = new Set();
let suppressExistingPrepNotifications = false;
let bulkLinks = [];
let connectionState = 'Connecting';
let theme = localStorage.getItem('theme') || 'light';
let currentUser = null;
let adminViewRole = '';
let realtimeChannel = null;
let presencePollTimer = null;
let heartbeatTimer = null;
let sidekickLogTimer = null;
let reconnectTimer = null;
let recoveryPromise = null;
let claimWindowTimers = new Map();
let updateState = {
  status: 'idle',
  message: 'Ready to check for updates.',
  version: '',
  progress: null
};
let unsubscribeUpdateState = null;

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;'
}[char]));

function formatDate(value) {
  if (!value) return 'none';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.valueOf())) return String(value);
  return date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

function formatDateRange(start, end) {
  return `${formatDate(start)} - ${formatDate(end)}`;
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return `${date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })} ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

function displayValue(value) {
  return value === null || value === undefined || value === '' ? 'none' : String(value);
}

function readRememberedUser() {
  try {
    return JSON.parse(localStorage.getItem('rememberedAppUser') || 'null');
  } catch {
    return null;
  }
}

function persistCurrentUser(user) {
  currentUser = user;
}

function effectiveRole() {
  return currentUser?.role === 'Admin' && adminViewRole ? adminViewRole : currentUser?.role;
}

function allowedViews() {
  return roleViews[effectiveRole()] || [];
}

function canView(name) {
  return allowedViews().includes(name);
}

function canManageUsers() {
  return currentUser && userManagerRoles.includes(effectiveRole());
}

function canActivateNewHireMode() {
  return effectiveRole() === 'Lead';
}

function canEditFiles() {
  return currentUser && effectiveRole() !== 'Device Coordinator';
}

function hasProfileView() {
  return canView('profile');
}

function hasUserProfile(user) {
  return user && profileRoles.includes(user.role);
}

function currentUserName() {
  return `${currentUser?.firstName || ''} ${currentUser?.lastName || ''}`.trim();
}

function currentUserInitials() {
  return `${currentUser?.firstName?.[0] || ''}${currentUser?.lastName?.[0] || ''}`.toUpperCase();
}

function specialistNames() {
  const names = specialists.map((user) => `${user.firstName} ${user.lastName}`.trim()).filter(Boolean);
  if (currentUser?.role === 'Device Systems Specialist') names.push(currentUserName());
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function firstAllowedView() {
  return allowedViews()[0] || 'dashboard';
}

function normalizeView() {
  if (view === 'profile' && canManageUsers() && selectedProfileId) return;
  if (!canView(view)) view = firstAllowedView();
}

function navButton(name, label) {
  return canView(name) ? `<button id="nav-${name}" type="button">${label}</button>` : '';
}

function adminRolePreviewControl() {
  if (currentUser?.role !== 'Admin') return '';
  return `
    <label class="view-as">
      <span>View as</span>
      <select id="adminViewRole">
        <option value="">Admin</option>
        ${roles.filter((role) => role !== 'Admin').map((role) => `<option value="${esc(role)}" ${adminViewRole === role ? 'selected' : ''}>${esc(role)}</option>`).join('')}
      </select>
    </label>
  `;
}

function updateButtonLabel() {
  if (!window.dashboardUpdates || updateState.status === 'disabled') return 'Installed app only';
  if (updateState.status === 'checking') return 'Checking...';
  if (updateState.status === 'available') return 'Download update';
  if (updateState.status === 'downloading') return `${updateState.progress ?? 0}%`;
  if (updateState.status === 'downloaded') return 'Restart to update';
  return 'Check for updates';
}

function updateButtonDisabled() {
  return !window.dashboardUpdates || ['disabled', 'checking', 'downloading'].includes(updateState.status);
}

function updateControl() {
  return `
    <div class="update-control" aria-live="polite">
      <span id="updateStatus">${esc(updateState.message)}</span>
      <button id="updateButton" class="btn ghost header-btn" type="button" ${updateButtonDisabled() ? 'disabled' : ''}>${esc(updateButtonLabel())}</button>
    </div>
  `;
}

function renderUpdateControl() {
  const status = $('updateStatus');
  const button = $('updateButton');
  if (status) status.textContent = updateState.message || 'Ready to check for updates.';
  if (button) {
    button.textContent = updateButtonLabel();
    button.disabled = updateButtonDisabled();
  }
}

function bindUpdateControl() {
  const button = $('updateButton');
  if (button) button.addEventListener('click', handleUpdateButton);
  renderUpdateControl();

  if (!window.dashboardUpdates || unsubscribeUpdateState) return;
  unsubscribeUpdateState = window.dashboardUpdates.onState((state) => {
    updateState = { ...updateState, ...state };
    renderUpdateControl();
  });
  window.dashboardUpdates.getState()
    .then((state) => {
      updateState = { ...updateState, ...state };
      renderUpdateControl();
    })
    .catch(() => {
      updateState = { ...updateState, status: 'error', message: 'Update status unavailable.' };
      renderUpdateControl();
    });
}

async function handleUpdateButton() {
  if (!window.dashboardUpdates) return;
  try {
    if (updateState.status === 'available') {
      updateState = { ...updateState, status: 'downloading', message: 'Starting update download...', progress: 0 };
      renderUpdateControl();
      await window.dashboardUpdates.download();
      return;
    }
    if (updateState.status === 'downloaded') {
      await window.dashboardUpdates.install();
      return;
    }
    updateState = { ...updateState, status: 'checking', message: 'Checking for updates...', progress: null };
    renderUpdateControl();
    await window.dashboardUpdates.check();
  } catch (error) {
    updateState = { ...updateState, status: 'error', message: error?.message || 'Update action failed.' };
    renderUpdateControl();
  }
}

function renderShell() {
  document.documentElement.dataset.theme = theme;
  document.querySelector('#app').innerHTML = `
    <header>
      <div>
        <div class="eyebrow">Shared operations workspace</div>
        <h1>Trials Dashboard</h1>
      </div>
      <div class="header-actions">
        ${updateControl()}
        <button id="themeToggle" class="btn ghost header-btn" type="button">${theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
        <div class="current-user">
          <strong>${esc(currentUser?.firstName || '')} ${esc(currentUser?.lastName || '')}</strong>
          <span>${esc(effectiveRole() || '')}${adminViewRole ? ` preview, actual ${esc(currentUser?.role || '')}` : ''}</span>
        </div>
        ${adminRolePreviewControl()}
        <button id="logoutButton" class="btn ghost header-btn" type="button">Log out</button>
        <div class="connection">
          <span id="connectionDot" class="dot"></span>
          <span id="connectionText">Connecting</span>
        </div>
      </div>
    </header>
    <div class="wrap">
      <aside class="card">
        <div class="profile"><strong>Shared dashboard</strong><span>Supabase live queue</span></div>
        <nav class="nav">
          ${navButton('leadDashboard', '▤ Lead Dashboard')}
          ${navButton('dashboard', '▦ Dashboard')}
          ${navButton('preprep', '⇄ Device Systems Dashboard')}
          ${navButton('shipping', '▣ Shipping')}
          ${navButton('users', '◎ User Management')}
          ${navButton('profile', '◌ Profile')}
        </nav>
      </aside>
      <main class="main">
        <section class="card toolbar">
          <div><h2 id="viewTitle"></h2><div class="muted" id="viewSub"></div></div>
          <input id="search" class="search" placeholder="Search client, device, loan type...">
        </section>
        <section class="stats" id="stats"></section>
        <section class="card section hide" id="leadDashboardView">
          <div class="preprep-head">
            <div><h3>Lead Dashboard</h3><div class="muted">Team schedules, training, queue visibility, shipped files, and persistent weekly/monthly totals.</div></div>
            <button id="leadCleanupButton" class="btn secondary" type="button">End of day cleanup</button>
          </div>
          <div class="tabs">
            <button id="lead-tab-schedules" class="tab active" type="button">Schedules</button>
            <button id="lead-tab-training" class="tab" type="button">Trained On</button>
            <button id="lead-tab-weekly" class="tab" type="button">Weekly User Totals</button>
            <button id="lead-tab-totals" class="tab" type="button">Loan / Device Totals</button>
            <button id="lead-tab-cleanups" class="tab" type="button">End of Day Cleanups</button>
          </div>
          <div id="leadDashboardBody"></div>
        </section>
        <section class="card section" id="dashboardView">
          <div class="preprep-head">
            <div><h3>Active device queue</h3><div class="muted">Files are organized into lanes in the order the team should work them.</div></div>
          </div>
          <div class="kanban" id="dashboardLanes"></div>
        </section>
        <section class="card section hide" id="preprepView">
          <div class="preprep-head">
            <div><h3>Device Systems Dashboard</h3><p class="muted">Claim files, prepare devices, and manage the shared GIPOD code inventory.</p></div>
            <div class="actions">
              <button id="bulkFilesButton" class="btn" type="button">+ Bulk add files</button>
              <button id="bulkDeleteFilesButton" class="btn danger" type="button" disabled>Delete selected (0)</button>
              <button id="bulkCodesButton" class="btn hide" type="button">+ Bulk import codes</button>
            </div>
          </div>
          <div class="tabs">
            <button id="tab-files" class="tab active" type="button">Files</button>
            <button id="tab-codes" class="tab" type="button">GIPOD Codes</button>
          </div>
          <div id="prepFilesPanel">
            <div class="tabs assignment-tabs" id="prepperTabs" aria-label="Filter files by specialist"></div>
            <div class="table-wrap">
              <table class="table device-systems-table"><thead><tr><th class="select-cell"><input id="selectAllFiles" type="checkbox" aria-label="Select all visible files"></th><th>Client</th><th>CRM #</th><th>Device</th><th>Device #</th><th>Vocabulary requested</th><th>GIPOD</th><th>Loan</th><th>Lane</th><th>Accessories</th><th>Notes</th><th>Specialist</th><th>Status</th><th>Queue date</th><th></th></tr></thead><tbody id="preprepRows"></tbody></table>
            </div>
          </div>
          <div id="prepCodesPanel" class="table-wrap hide">
            <p class="help">Use a code manually by entering its 5-digit CRM number. If a CRM number is used more than once, the duplicate rows are highlighted light red until a note is added to either one.</p>
            <div class="tabs sub-tabs">
              <button id="code-tab-unused" class="tab active" data-action="code-filter" data-name="unused" type="button">Unused <span id="unusedCodeCount" class="count">0</span></button>
              <button id="code-tab-used" class="tab" data-action="code-filter" data-name="used" type="button">Used <span id="usedCodeCount" class="count">0</span></button>
            </div>
            <table class="table"><thead><tr><th>GIPOD code</th><th>Status</th><th>CRM number used on</th><th>Used date</th><th>Note</th><th></th></tr></thead><tbody id="gipodRows"></tbody></table>
          </div>
        </section>
        <section class="card section hide" id="shippingView">
          <div class="preprep-head">
            <div><h3>Shipping queue</h3><div class="muted">Mark completed devices as shipped to move them into the Shipped lane.</div></div>
            <button id="shippingCleanupButton" class="btn secondary" type="button">End of day cleanup</button>
          </div>
          <div class="kanban" id="shippingLanes"></div>
        </section>
        ${canManageUsers() ? `
        <section class="card section hide" id="usersView">
          <div class="preprep-head">
            <div><h3>User Management</h3><div class="muted">Assign user roles now. Permission controls are reserved for the next app phase.</div></div>
            <button id="refreshUsersButton" class="btn secondary" type="button">Refresh users</button>
          </div>
          <form id="createUserForm" class="form user-create">
            <div class="field"><label for="newUserFirst">First name</label><input id="newUserFirst" required></div>
            <div class="field"><label for="newUserLast">Last name</label><input id="newUserLast" required></div>
            <div class="field"><label for="newUserPin">4-digit PIN</label><input id="newUserPin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></div>
            <div class="field"><label for="newUserRole">Role</label><select id="newUserRole">${roles.map((role) => `<option value="${esc(role)}">${esc(role)}</option>`).join('')}</select></div>
            <div class="field button-field"><button class="btn" type="submit">Create user</button></div>
          </form>
          <div id="usersMessage" class="muted"></div>
          <div class="table-wrap">
            <table class="table user-table"><thead><tr><th>User</th><th>Role</th><th>PIN</th><th>Permissions</th><th>Status</th><th></th></tr></thead><tbody id="userRows"></tbody></table>
          </div>
        </section>
        ` : ''}
        <section class="card section hide" id="profileView">
          <div class="preprep-head"><div><h3 id="profileName">Profile</h3><div class="muted" id="profileRole"></div></div></div>
          <div id="profileBody"></div>
        </section>
      </main>
    </div>
    ${dialogs()}
  `;

  bindUpdateControl();
  if ($('nav-leadDashboard')) $('nav-leadDashboard').addEventListener('click', () => setView('leadDashboard'));
  if ($('nav-dashboard')) $('nav-dashboard').addEventListener('click', () => setView('dashboard'));
  $('themeToggle').addEventListener('click', toggleTheme);
  if ($('nav-preprep')) $('nav-preprep').addEventListener('click', () => setView('preprep'));
  if ($('nav-shipping')) $('nav-shipping').addEventListener('click', () => setView('shipping'));
  $('logoutButton').addEventListener('click', logout);
  if ($('nav-users')) $('nav-users').addEventListener('click', () => setView('users'));
  if ($('nav-profile')) $('nav-profile').addEventListener('click', () => openProfile(currentUser.id));
  if ($('adminViewRole')) $('adminViewRole').addEventListener('change', setAdminViewRole);
  if ($('refreshUsersButton')) $('refreshUsersButton').addEventListener('click', loadUsers);
  if ($('createUserForm')) $('createUserForm').addEventListener('submit', createUser);
  if ($('shippingCleanupButton')) $('shippingCleanupButton').addEventListener('click', endOfDayCleanup);
  if ($('leadCleanupButton')) $('leadCleanupButton').addEventListener('click', endOfDayCleanup);
  $('search').addEventListener('input', renderCurrentView);
  $('bulkFilesButton').addEventListener('click', showBulkModal);
  $('bulkDeleteFilesButton').addEventListener('click', bulkDeleteFiles);
  $('bulkCodesButton').addEventListener('click', showCodeModal);
  $('tab-files').addEventListener('click', () => setPrepTab('files'));
  $('tab-codes').addEventListener('click', () => setPrepTab('codes'));
  ['schedules', 'training', 'weekly', 'totals', 'cleanups'].forEach((tab) => {
    if ($(`lead-tab-${tab}`)) $(`lead-tab-${tab}`).addEventListener('click', () => setLeadTab(tab));
  });
  $('fileForm').addEventListener('submit', saveFile);
  $('bulkForm').addEventListener('submit', addBulkFiles);
  $('bulkRows').addEventListener('paste', captureExcelPaste);
  $('bulkRows').addEventListener('input', () => {
    clearBulkLinks();
    previewBulkRows();
  });
  $('bulkPreview').addEventListener('input', validateEditedBulkRows);
  $('codeForm').addEventListener('submit', addGipodCodes);
  $('codeRows').addEventListener('input', previewGipodCodes);
  $('useCodeForm').addEventListener('submit', saveManualGipodUse);
  $('editLoan').addEventListener('input', syncLaneFromLoan);
  $('editExpires').addEventListener('input', syncLaneFromShipBy);
  $('addCameraButton').addEventListener('click', addCameraField);
  setConnection('Connecting');
}

function dialogs() {
  return `
    <dialog id="fileModal"><form method="dialog" id="fileForm" class="section"><div class="dialog-head"><div><div class="eyebrow">Client file</div><h3 id="fileModalTitle">Edit file</h3></div><button class="icon-btn" type="button" data-action="close-dialog" aria-label="Close">x</button></div><input type="hidden" id="editId"><div class="tabs file-tabs"><button id="file-tab-details" class="tab active" data-action="file-tab" data-name="details" type="button">Details</button><button id="file-tab-log" class="tab" data-action="file-tab" data-name="log" type="button">Log</button></div><div id="fileDetailsPanel" class="form">
      <div class="field"><label for="editLast">Last name</label><input id="editLast" required></div><div class="field"><label for="editFirst">First name</label><input id="editFirst" required></div>
      <div class="field"><label for="editDevice">Device</label><input id="editDevice" required></div><div class="field"><label for="editDeviceNumber">Device number</label><input id="editDeviceNumber" placeholder="Device asset number"></div>
      <div class="field"><label for="editGipod">GIPOD code</label><input id="editGipod" placeholder="GIPOD code"></div><div class="field"><label for="editCameraNumber">Camera 1</label><input id="editCameraNumber" placeholder="Camera asset number"></div>
      <div id="cameraFields" class="full camera-fields"></div>
      <div class="full"><button id="addCameraButton" class="btn small secondary" type="button">+ Add camera</button></div>
      <div class="field"><label for="editLoan">Loan type</label><input id="editLoan"></div><div class="field"><label for="editVocab">Vocabulary requested</label><input id="editVocab"></div>
      <div class="field"><label for="editDate">Queue date</label><input id="editDate" type="date"></div><div class="field"><label for="editExpires">Ship by date</label><input id="editExpires" type="date"></div>
      <div class="field"><label for="editStatus">Status</label><select id="editStatus"><option>Ready for Pre-Prep</option><option>Ready for Prep</option><option>Ready for QA</option><option>Complete</option><option>Shipped</option></select></div><div class="field full"><label for="editLane">Dashboard lane</label><select id="editLane"><option>Expedites</option><option>Funded Rentals</option><option>Ship Requested</option><option>Accessories</option><option>Daily Queue</option></select></div>
      <div class="field full"><label for="editCrm">CRM link</label><input id="editCrm" type="url" placeholder="https://crm.example.com/record/..."></div><div class="field full"><label for="editNotes">Notes</label><textarea id="editNotes"></textarea></div>
    </div><div id="fileLogPanel" class="hide"></div><div class="footer"><a id="editCrmButton" class="btn ghost" href="#" target="_blank" rel="noopener">Open CRM</a><button id="unassignFileButton" class="btn secondary" type="button" data-action="unassign-file">Unassign file</button><button class="btn secondary" type="button" data-action="close-dialog">Cancel</button><button class="btn" type="submit">Save changes</button></div></form></dialog>

    <dialog id="bulkModal" class="wide-dialog"><form method="dialog" id="bulkForm" class="section bulk"><div class="dialog-head"><div><div class="eyebrow">Device Systems intake</div><h3>Bulk add files</h3></div><button class="icon-btn" type="button" data-action="close-dialog" aria-label="Close">x</button></div><p class="help">Copy rows in Excel and paste them here in this exact order: <b>Last Name | First Name | Device | Loan Type | Queue Date | Vocabulary | Accessories/Keyguard/Notes</b>. Review and edit every line below before importing.</p><div class="field"><label for="bulkRows">Excel rows</label><textarea id="bulkRows" placeholder="Paste tab-separated rows here..."></textarea></div><div id="bulkMessage" class="muted"></div><div id="bulkPreview" class="preview bulk-preview hide"></div><div class="footer"><button class="btn secondary" type="button" data-action="close-dialog">Cancel</button><button id="bulkSubmit" class="btn" type="submit">Add files to Device Systems</button></div></form></dialog>

    <dialog id="codeModal"><form method="dialog" id="codeForm" class="section bulk"><div class="dialog-head"><div><div class="eyebrow">Code inventory</div><h3>Bulk import GIPOD codes</h3></div><button class="icon-btn" type="button" data-action="close-dialog" aria-label="Close">x</button></div><p class="help">Copy the GIPOD code column from Excel and paste it below. Duplicate and blank codes will be skipped.</p><div class="field"><label for="codeRows">GIPOD codes</label><textarea id="codeRows" placeholder="Paste one code per row..."></textarea></div><div id="codeMessage" class="muted"></div><div class="footer"><button class="btn secondary" type="button" data-action="close-dialog">Cancel</button><button class="btn" type="submit">Import codes</button></div></form></dialog>

    <dialog id="useCodeModal"><form method="dialog" id="useCodeForm" class="section"><div class="dialog-head"><div><div class="eyebrow">Code inventory</div><h3 id="useCodeTitle">Use GIPOD code</h3></div><button class="icon-btn" type="button" data-action="close-dialog" aria-label="Close">x</button></div><input type="hidden" id="useCodeId"><div class="form">
      <div class="field full"><label for="useCodeCrm">5-digit CRM number</label><input id="useCodeCrm" inputmode="numeric" autocomplete="off" pattern="[0-9]{5}" maxlength="5" placeholder="12345" required><span class="muted">Enter exactly five digits.</span></div>
      <div class="field full"><label for="useCodeNote">Note (one required per duplicated CRM number)</label><textarea id="useCodeNote" placeholder="Explain why this CRM number uses another GIPOD code..."></textarea></div>
    </div><div class="footer"><button class="btn secondary" type="button" data-action="close-dialog">Cancel</button><button class="btn" type="submit">Save usage</button></div></form></dialog>
  `;
}

function renderConfig() {
  document.documentElement.dataset.theme = theme;
  document.querySelector('#app').innerHTML = `
    <section class="card config">
      <div class="eyebrow">Supabase setup</div>
      <h1>Connect Trials Dashboard</h1>
      <p class="notice">Add your free Supabase project URL and publishable/anon key. The schema in <b>supabase/schema.sql</b> must be installed first.</p>
      <form id="configForm" class="form">
        <div class="field"><label for="configUrl">Supabase URL</label><input id="configUrl" value="${esc(SUPABASE_URL)}" placeholder="https://project-ref.supabase.co" required></div>
        <div class="field"><label for="configKey">Publishable or anon key</label><input id="configKey" value="${esc(SUPABASE_KEY)}" required></div>
        <div class="footer"><button class="btn" type="submit">Save and connect</button></div>
      </form>
    </section>
  `;
  $('configForm').addEventListener('submit', (event) => {
    event.preventDefault();
    localStorage.setItem('supabaseUrl', $('configUrl').value.trim());
    localStorage.setItem('supabaseAnonKey', $('configKey').value.trim());
    location.reload();
  });
}

function renderLogin() {
  const rememberedUser = readRememberedUser();
  document.documentElement.dataset.theme = theme;
  document.querySelector('#app').innerHTML = `
    <main class="auth-page">
      <section class="card auth-card">
        <div class="auth-head">
          <div class="eyebrow">Smartbox trials</div>
          <h1>Welcome to the Smartbox Trials Dashboard!</h1>
        </div>
        <form id="authForm" class="form auth-form">
          <div class="field"><label for="authFirstName">First name</label><input id="authFirstName" autocomplete="given-name" value="${esc(rememberedUser?.firstName || '')}" required></div>
          <div class="field"><label for="authLastName">Last name</label><input id="authLastName" autocomplete="family-name" value="${esc(rememberedUser?.lastName || '')}" required></div>
          <div class="field full"><label for="authPin">4-digit PIN</label><input id="authPin" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{4}" maxlength="4" placeholder="1234" required></div>
          <label class="check-row full"><input id="rememberUser" type="checkbox" ${rememberedUser ? 'checked' : ''}> Remember my name on this computer</label>
          <div id="authMessage" class="muted full">Enter your name and PIN to continue. Admins and Leads add users in User Management.</div>
          <div class="footer full">
            <button id="themeToggle" class="btn ghost" type="button">${theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
            <button id="authSubmit" class="btn" type="submit">Login</button>
          </div>
        </form>
      </section>
    </main>
  `;
  $('themeToggle').addEventListener('click', toggleTheme);
  $('authForm').addEventListener('submit', submitAuth);
}

function authPayload() {
  return {
    p_first_name: $('authFirstName').value.trim(),
    p_last_name: $('authLastName').value.trim(),
    p_pin: $('authPin').value.trim()
  };
}

function cleanRpcMessage(message) {
  return (message || 'Supabase error').replace(/^ERROR:\s*/i, '');
}

async function submitAuth(event) {
  event.preventDefault();
  const payload = authPayload();
  if (!/^\d{4}$/.test(payload.p_pin)) {
    $('authMessage').className = 'error full';
    $('authMessage').textContent = 'PIN must be exactly 4 digits.';
    return;
  }
  $('authSubmit').disabled = true;
  $('authMessage').className = 'muted full';
  $('authMessage').textContent = 'Logging in...';

  const { data, error } = await supabase.rpc('login_app_user', payload);
  $('authSubmit').disabled = false;

  if (error) {
    $('authMessage').className = 'error full';
    $('authMessage').textContent = cleanRpcMessage(error.message);
    return;
  }
  if (!data) {
    $('authMessage').className = 'error full';
    $('authMessage').textContent = 'Name or PIN did not match an active user.';
    return;
  }

  if ($('rememberUser').checked) {
    localStorage.setItem('rememberedAppUser', JSON.stringify({
      firstName: payload.p_first_name,
      lastName: payload.p_last_name
    }));
  } else {
    localStorage.removeItem('rememberedAppUser');
  }
  persistCurrentUser(data);
  suppressExistingPrepNotifications = true;
  adminViewRole = '';
  view = firstAllowedView();
  await startApp();
}

async function markCurrentUserLoggedIn(isLoggedIn, keepalive = false) {
  if (!currentUser?.id || !SUPABASE_URL || !SUPABASE_KEY) return;
  const payload = { p_user_id: currentUser.id, p_logged_in: isLoggedIn };
  if (keepalive && window.fetch) {
    fetch(`${SUPABASE_URL}/rest/v1/rpc/set_app_user_login_status`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {});
    return;
  }
  const { error } = await supabase.rpc('set_app_user_login_status', payload);
  if (error) console.error('Unable to update login status:', error);
}

async function logout() {
  await markCurrentUserLoggedIn(false);
  unsubscribeRealtime();
  stopPresencePolling();
  stopHeartbeat();
  stopSidekickLogDrain();
  if (window.dashboardSidekick?.clearProfile) await window.dashboardSidekick.clearProfile().catch(() => {});
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  activePrepNotifications.forEach((entry) => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.element?.remove();
  });
  activePrepNotifications.clear();
  seenPrepNotifications.clear();
  claimWindowTimers.forEach((timer) => clearTimeout(timer));
  claimWindowTimers.clear();
  persistCurrentUser(null);
  adminViewRole = '';
  view = 'dashboard';
  users = [];
  profileSidekickLogs = [];
  renderLogin();
}

function setAdminViewRole(event) {
  adminViewRole = event.target.value;
  normalizeView();
  renderShell();
  render();
}

function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', theme);
  document.documentElement.dataset.theme = theme;
  const button = $('themeToggle');
  if (button) button.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
}

function rowToFile(row) {
  return {
    id: row.id,
    last: row.last_name,
    first: row.first_name,
    device: row.device,
    deviceNumber: row.device_number || '',
    gipod: row.gipod_code || '',
    cameraNumber: row.camera_number || '',
    cameraNumber2: row.camera_number_2 || '',
    cameraNumber3: row.camera_number_3 || '',
    cameraNumber4: row.camera_number_4 || '',
    loan: row.loan_type || '',
    date: row.queue_date || '',
    expires: row.expiration_date || '',
    vocab: row.vocabulary || '',
    notes: row.notes || '',
    priority: row.priority || 'Normal',
    status: row.status || 'Ready for Pre-Prep',
    lane: row.lane || 'Daily Queue',
    crm: row.crm_link || '',
    prepper: row.prepper || '',
    preppedBy: row.prepped_by || '',
    qaBy: row.qa_by || '',
    preppedById: row.prepped_by_user_id || '',
    qaById: row.qa_by_user_id || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || ''
  };
}

function fileToRow(file) {
  const lane = file.lane || (file.expires ? 'Ship Requested' : laneForLoan(file.loan || ''));
  return {
    last_name: file.last,
    first_name: file.first,
    device: file.device,
    device_number: file.deviceNumber || '',
    gipod_code: file.gipod || '',
    camera_number: file.cameraNumber || '',
    camera_number_2: file.cameraNumber2 || '',
    camera_number_3: file.cameraNumber3 || '',
    camera_number_4: file.cameraNumber4 || '',
    loan_type: file.loan || '',
    queue_date: file.date || null,
    expiration_date: file.expires || null,
    vocabulary: file.vocab || '',
    notes: file.notes || '',
    priority: priorityForLane(lane),
    status: file.status || 'Ready for Pre-Prep',
    lane,
    crm_link: file.crm || '',
    prepper: file.prepper || '',
    prepped_by: file.preppedBy || '',
    qa_by: file.qaBy || '',
    prepped_by_user_id: file.preppedById || null,
    qa_by_user_id: file.qaById || null
  };
}

function setConnection(state, detail = '') {
  const dot = $('connectionDot');
  const text = $('connectionText');
  if (state !== 'Refreshing') connectionState = detail || state;
  if (!dot || !text) return;
  dot.className = `dot ${state === 'Live' ? 'online' : state === 'Error' ? 'error' : state === 'Refreshing' ? 'refreshing' : ''}`;
  text.textContent = state === 'Refreshing' ? (connectionState === 'Connecting' ? 'Live' : connectionState) : connectionState;
}

function createSupabaseClient() {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

function resultError(result) {
  if (Array.isArray(result)) return result.find((item) => item?.error)?.error || null;
  return result?.error || null;
}

function isRecoverableSupabaseError(error) {
  const message = `${error?.message || error?.name || error || ''}`.toLowerCase();
  const status = Number(error?.status || error?.code || 0);
  return [408, 429, 500, 502, 503, 504].includes(status) ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('connection') ||
    message.includes('websocket') ||
    message.includes('abort');
}

function isMissingSidekickLogSchema(error) {
  const message = `${error?.message || error?.details || error?.hint || ''}`.toLowerCase();
  return ['pgrst202', '42p01', '42883'].includes(String(error?.code || '').toLowerCase()) ||
    message.includes('list_app_sidekick_logs') ||
    message.includes('app_sidekick_logs') ||
    message.includes('log_app_sidekick_action');
}

async function recoverSupabaseConnection(reason = 'Connection recovered') {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async () => {
    setConnection('Refreshing', 'Reconnecting');
    unsubscribeRealtime();
    createSupabaseClient();
    if (currentUser?.id) await markCurrentUserLoggedIn(true);
    subscribeRealtime();
    setConnection('Live', reason);
  })().finally(() => {
    recoveryPromise = null;
  });
  return recoveryPromise;
}

async function withSupabaseRetry(operation) {
  let result;
  try {
    result = await operation();
  } catch (error) {
    if (!isRecoverableSupabaseError(error)) throw error;
    await recoverSupabaseConnection(error.message || 'Supabase reconnect');
    try {
      return await operation();
    } catch (retryError) {
      return { error: retryError };
    }
  }
  const error = resultError(result);
  if (error && isRecoverableSupabaseError(error)) {
    await recoverSupabaseConnection(error.message || 'Supabase reconnect');
    try {
      return await operation();
    } catch (retryError) {
      return { error: retryError };
    }
  }
  return result;
}

function scheduleRealtimeReconnect(reason) {
  setConnection('Refreshing', reason);
  if (reconnectTimer) return;
  reconnectTimer = window.setTimeout(async () => {
    reconnectTimer = null;
    try {
      await recoverSupabaseConnection(reason);
      await loadData();
    } catch (error) {
      showError(error);
    }
  }, 1500);
}

async function loadData() {
  setConnection(connectionState === 'Live' ? 'Refreshing' : 'Connecting', connectionState === 'Live' ? 'Live' : 'Loading queue');
  const loadResults = await withSupabaseRetry(() => Promise.all([
    supabase.from('trial_files').select('*').order('created_at', { ascending: true }).order('id', { ascending: true }),
    supabase.from('gipod_codes').select('*').order('created_at', { ascending: true }),
    supabase.rpc('list_device_specialists'),
    supabase.rpc('list_device_coordinators')
  ]));
  if (!Array.isArray(loadResults)) throw resultError(loadResults) || new Error('Unable to reload queue.');
  const [fileResult, codeResult, specialistResult, coordinatorResult] = loadResults;

  if (fileResult.error) throw fileResult.error;
  if (codeResult.error) throw codeResult.error;
  if (specialistResult.error) throw specialistResult.error;
  if (coordinatorResult.error) throw coordinatorResult.error;

  files = fileResult.data.map(rowToFile);
  gipodCodes = codeResult.data.map((row) => ({
    id: row.id,
    code: row.code,
    usedOn: row.used_on || '',
    usedDate: row.used_date || '',
    note: row.note || ''
  }));
  specialists = specialistResult.data.map(rowToSpecialist);
  coordinators = coordinatorResult.data.map(rowToSpecialist);
  if (canManageUsers()) {
    await loadUsers(false);
    await loadLeadDashboardData();
  }
  if (view === 'profile' && selectedProfileId) await loadProfile(selectedProfileId);
  queuePrepReadyNotifications();
  setConnection('Live');
  render();
}

async function loadLeadDashboardData() {
  const leadResults = await withSupabaseRetry(() => Promise.all([
    supabase.rpc('list_team_user_activity', { p_actor_id: currentUser.id }),
    supabase.from('app_shipment_activity').select('*').order('shipped_date', { ascending: false }).order('shipped_at', { ascending: false }),
    supabase.from('app_eod_cleanups').select('*').order('cleanup_date', { ascending: false }).order('created_at', { ascending: false })
  ]));
  if (!Array.isArray(leadResults)) throw resultError(leadResults) || new Error('Unable to reload lead dashboard.');
  const [activityResult, shipmentResult, cleanupResult] = leadResults;
  if (activityResult.error) throw activityResult.error;
  if (shipmentResult.error) throw shipmentResult.error;
  if (cleanupResult.error) throw cleanupResult.error;
  teamActivity = activityResult.data || [];
  shipmentHistory = shipmentResult.data || [];
  eodCleanups = cleanupResult.data || [];
}

function rowToSpecialist(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    trainedDevices: row.trained_devices || [],
    isNewHire: Boolean(row.is_new_hire),
    isLoggedIn: Boolean(row.is_logged_in)
  };
}

async function loadSpecialists() {
  const { data, error } = await supabase.rpc('list_device_specialists');
  if (error) return showError(error);
  specialists = data.map(rowToSpecialist);
}

function rowToUser(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    permissions: row.permissions || {},
    weeklySchedule: row.weekly_schedule || {},
    trainedDevices: row.trained_devices || [],
    isNewHire: Boolean(row.is_new_hire),
    isActive: row.is_active,
    isLoggedIn: row.is_logged_in,
    lastLoginAt: row.last_login_at || '',
    lastLogoutAt: row.last_logout_at || ''
  };
}

async function loadUsers(shouldRender = true) {
  if (!canManageUsers()) return;
  const { data, error } = await supabase.rpc('list_app_users', { p_actor_id: currentUser.id });
  if (error) return showError(error);
  users = data.map(rowToUser);
  if (shouldRender) renderUsers();
}

async function loadProfile(userId = selectedProfileId || currentUser.id) {
  if (!userId) return;
  selectedProfileId = userId;
  const [profileResult, activityResult, sidekickResult] = await Promise.all([
    supabase.rpc('get_app_user_profile', { p_actor_id: currentUser.id, p_user_id: userId }),
    supabase.rpc('list_app_user_activity', { p_actor_id: currentUser.id, p_user_id: userId }),
    supabase.rpc('list_app_sidekick_logs', { p_actor_id: currentUser.id, p_user_id: userId })
  ]);
  if (profileResult.error) return showError(profileResult.error);
  if (activityResult.error) return showError(activityResult.error);
  if (sidekickResult.error && !isMissingSidekickLogSchema(sidekickResult.error)) return showError(sidekickResult.error);
  profileUser = profileResult.data;
  profileActivity = activityResult.data || [];
  profileSidekickLogs = sidekickResult.error ? [] : sidekickResult.data || [];
}

async function loadFileLogs(fileId) {
  const { data, error } = await supabase
    .from('app_file_logs')
    .select('*')
    .eq('file_id', fileId)
    .order('created_at', { ascending: false });
  if (error) return showError(error);
  fileLogs = data || [];
  renderFileLogPanel();
}

function subscribeRealtime() {
  unsubscribeRealtime();
  realtimeChannel = supabase
    .channel(`trials-dashboard-db-changes-${Date.now()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trial_files' }, loadData)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'gipod_codes' }, loadData)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_shipment_activity' }, loadData)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_eod_cleanups' }, loadData)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') setConnection('Live');
      if (status === 'CHANNEL_ERROR') scheduleRealtimeReconnect('Realtime reconnecting');
      if (status === 'TIMED_OUT') scheduleRealtimeReconnect('Realtime timed out');
    });
}

function unsubscribeRealtime() {
  if (!supabase || !realtimeChannel) return;
  supabase.removeChannel(realtimeChannel);
  realtimeChannel = null;
}

function startPresencePolling() {
  stopPresencePolling();
  if (!canManageUsers()) return;
  presencePollTimer = window.setInterval(() => {
    loadUsers(true);
  }, 10000);
}

function stopPresencePolling() {
  if (!presencePollTimer) return;
  clearInterval(presencePollTimer);
  presencePollTimer = null;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = window.setInterval(async () => {
    if (!currentUser || !supabase) return;
    try {
      const result = await withSupabaseRetry(() => supabase.from('trial_files').select('id', { head: true }).limit(1));
      const error = resultError(result);
      if (error) throw error;
      if (connectionState !== 'Live') setConnection('Live');
    } catch (error) {
      if (isRecoverableSupabaseError(error)) scheduleRealtimeReconnect('Connection reconnecting');
      else console.error('Heartbeat failed:', error);
    }
  }, 30000);
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startSidekickLogDrain() {
  stopSidekickLogDrain();
  if (!window.dashboardSidekick?.takeLogs) return;
  sidekickLogTimer = window.setInterval(drainSidekickLogs, 5000);
  drainSidekickLogs();
}

function stopSidekickLogDrain() {
  if (!sidekickLogTimer) return;
  clearInterval(sidekickLogTimer);
  sidekickLogTimer = null;
}

async function drainSidekickLogs() {
  if (!currentUser?.id || !supabase || !window.dashboardSidekick?.takeLogs) return;
  const logs = await window.dashboardSidekick.takeLogs().catch((error) => {
    console.error('Unable to read Sidekick logs:', error);
    return [];
  });
  if (!Array.isArray(logs) || !logs.length) return;

  const rows = logs
    .filter((log) => log.userId)
    .map((log) => ({
      user_id: log.userId,
      action: log.action || 'Sidekick action',
      detail: log.detail || '',
      metadata: log.metadata || {},
      occurred_at: log.occurredAt || new Date().toISOString()
    }));
  if (!rows.length) return;

  const { error } = await withSupabaseRetry(() => supabase.from('app_sidekick_logs').insert(rows));
  if (error) {
    console.error('Sidekick log insert failed:', error);
    return;
  }
  if (view === 'profile' && selectedProfileId && rows.some((row) => row.user_id === selectedProfileId)) {
    await loadProfile(selectedProfileId);
    renderProfile();
  }
}

function statusClass(file) {
  const status = file.status.toLowerCase();
  if (file.priority === 'EXPEDITE') return 'expedite';
  if (status.includes('qa')) return 'qa';
  if (status.includes('prep')) return 'prep';
  if (['Complete', 'Shipped'].includes(file.status)) return 'ready';
  return 'open';
}

function filteredFiles() {
  const query = $('search').value.trim().toLowerCase();
  return files.filter((file) => `${file.first} ${file.last} ${file.device} ${file.deviceNumber} ${file.gipod} ${file.cameraNumber} ${file.cameraNumber2} ${file.cameraNumber3} ${file.cameraNumber4} ${file.vocab} ${file.loan} ${file.status}`.toLowerCase().includes(query));
}

function stableFileOrder(list) {
  return [...list].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
}

function isPrePrep(file) {
  return file.status === 'Ready for Pre-Prep';
}

function countBy(list, key) {
  return Object.entries(list.reduce((counts, file) => {
    const name = file[key] || 'Not listed';
    counts[name] = (counts[name] || 0) + 1;
    return counts;
  }, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function tableRows(rows, emptyText, colspan) {
  return rows.join('') || `<tr><td colspan="${colspan}"><div class="empty">${emptyText}</div></td></tr>`;
}

function fridayOfWeek(dateValue) {
  const friday = mondayOf(new Date(`${dateValue}T00:00:00`));
  friday.setDate(friday.getDate() + 4);
  return friday;
}

function lastFridayOfMonth(year, monthIndex) {
  const date = new Date(year, monthIndex + 1, 0);
  while (date.getDay() !== 5) date.setDate(date.getDate() - 1);
  return date;
}

function weeklyPeriod(dateValue) {
  const start = mondayOf(new Date(`${dateValue}T00:00:00`));
  const end = fridayOfWeek(dateValue);
  return {
    key: isoDate(start),
    label: formatDateRange(isoDate(start), isoDate(end))
  };
}

function monthlyPeriod(dateValue) {
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.valueOf())) return { key: 'Unknown', label: 'Unknown' };
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = lastFridayOfMonth(date.getFullYear(), date.getMonth());
  return {
    key: isoDate(start),
    label: formatDateRange(isoDate(start), isoDate(end))
  };
}

function formatAction(action) {
  if (action === 'prep_completed') return 'Prep completed';
  if (action === 'qa_completed') return 'QA completed';
  return action || 'No action';
}

function userFullName(user) {
  return `${user?.firstName || user?.first_name || ''} ${user?.lastName || user?.last_name || ''}`.trim();
}

function summaryGroup(title, counts) {
  return `<div class="card summary-group"><strong>${title}</strong><div class="summary-items">${counts.map(([label, count]) => `<span class="summary-chip">${esc(label)} <b>${count}</b></span>`).join('') || '<span class="muted">None</span>'}</div></div>`;
}

function renderStats() {
  const list = filteredFiles();
  if (view === 'leadDashboard') {
    $('stats').classList.remove('compact');
    $('stats').innerHTML = '';
    return;
  }
  if (view === 'users') {
    $('stats').classList.remove('compact');
    const totals = roles.map((role) => [role, users.filter((user) => user.role === role).length]);
    $('stats').innerHTML = totals.map(([label, value]) => `<div class="card stat"><b>${value}</b><span>${esc(label)}</span></div>`).join('');
    return;
  }
  if (view === 'profile') {
    $('stats').classList.remove('compact');
    $('stats').innerHTML = '';
    return;
  }
  if (view === 'preprep') {
    const prep = list.filter(isPrePrep);
    $('stats').classList.add('compact');
    $('stats').innerHTML = `<div class="card stat"><b>${prep.length}</b><span>Total files</span></div><div class="card stat"><b>${gipodCodes.filter((item) => !item.usedOn).length}</b><span>Available GIPOD codes</span></div>${summaryGroup('Device types', countBy(prep, 'device'))}${summaryGroup('Loan types', countBy(prep, 'loan'))}`;
    return;
  }
  const shipped = list.filter((file) => file.status === 'Shipped');
  if (view === 'dashboard') {
    $('stats').classList.remove('compact');
    const active = list.filter((file) => !isPrePrep(file) && !['Complete', 'Shipped'].includes(file.status));
    const totals = [['Total files', active.length], ['Expedites', active.filter((file) => file.lane === 'Expedites').length], ['Ship requested', active.filter((file) => file.lane === 'Ship Requested').length], ['Daily queue', active.filter((file) => file.lane === 'Daily Queue').length], ['Total shipped', shipped.length]];
    $('stats').innerHTML = totals.map(([label, value]) => `<div class="card stat"><b>${value}</b><span>${label}</span></div>`).join('') + summaryGroup('Shipped by loan type', countBy(shipped, 'loan')) + summaryGroup('Shipped by device type', countBy(shipped, 'device'));
    return;
  }
  $('stats').classList.remove('compact');
  const scoped = list.filter((file) => ['Complete', 'Shipped'].includes(file.status));
  const stats = [['Total files', scoped.length], ['Ready to ship', scoped.filter((file) => file.status === 'Complete').length], ['Shipped', shipped.length], ['Expedites', scoped.filter((file) => file.lane === 'Expedites').length]];
  $('stats').innerHTML = stats.map(([label, value]) => `<div class="card stat"><b>${value}</b><span>${label}</span></div>`).join('');
}

function actionButtons(file) {
  return `<div class="actions"><button class="btn small secondary" data-action="open-file" data-id="${file.id}">${canEditFiles() ? 'View / Edit' : 'View'}</button><a class="btn small ghost" href="${esc(file.crm || '#')}" target="_blank" rel="noopener">CRM</a></div>`;
}

function statusStepFor(file) {
  if (file.status.startsWith('Being prepped by ')) return 'Ready for QA';
  if (file.status.startsWith("Being QA'd by ")) return 'Complete';
  return statusSteps[file.status];
}

function workflowButtons(file) {
  const buttons = [];
  const isCoordinator = currentUser?.role === 'Device Coordinator' || effectiveRole() === 'Device Coordinator';
  const coordinator = currentCoordinatorProfile();
  if (isCoordinator && file.status === 'Ready for Prep' && canCoordinatorClaimPrepNow(file, coordinator)) {
    buttons.push(`<button class="btn small card-step" data-action="claim-prep" data-id="${file.id}">Claim prep</button>`);
  }
  if (isCoordinator && file.status === 'Ready for QA') {
    buttons.push(`<button class="btn small card-step" data-action="claim-qa" data-id="${file.id}">Claim QA</button>`);
  }
  const next = statusStepFor(file);
  if (next) buttons.push(`<button class="btn small card-step" data-action="next-step" data-id="${file.id}">Move to ${esc(next)}</button>`);
  return buttons.join('');
}

function prepQaLog(file) {
  const items = [];
  if (file.preppedBy) items.push(`Prepped by ${file.preppedBy}`);
  if (file.qaBy) items.push(`QA by ${file.qaBy}`);
  return items.length ? `<div class="file-log">${items.map(esc).join(' | ')}</div>` : '';
}

function fileCard(file, name) {
  const accessories = fileAccessories(file);
  return `<article class="file-card ${name === 'Expedites' ? 'ex' : ''}" data-action="open-file" data-id="${file.id}">
    <div class="topline"><b>${esc(file.last)}, ${esc(file.first)}</b><span class="pill ${statusClass(file)}">${esc(file.status)}</span></div>
    <div>${esc(file.device)}</div>
    <div class="file-meta">${esc(file.loan || 'No loan type')} - Ship by ${esc(formatDate(file.expires))}</div>
    <div class="file-card-details">
      <div><span>Vocabulary</span><b>${esc(file.vocab || 'none')}</b></div>
      <div><span>Accessories</span><b>${accessories.length ? accessories.map(esc).join(', ') : 'none'}</b></div>
    </div>
    ${prepQaLog(file)}${workflowButtons(file)}${actionButtons(file)}
  </article>`;
}

function renderLanes(target, list, names = laneNames) {
  $(target).innerHTML = names.map((name) => {
    const laneFiles = list.filter((file) => name === 'Shipped' ? file.status === 'Shipped' : file.status !== 'Shipped' && file.lane === name);
    return `<div class="lane"><h3>${name}<span class="count">${laneFiles.length}</span></h3>${laneFiles.map((file) => fileCard(file, name)).join('') || '<div class="empty">No files</div>'}</div>`;
  }).join('');
}

function renderDashboard() {
  renderLanes('dashboardLanes', filteredFiles().filter((file) => !isPrePrep(file) && !['Complete', 'Shipped'].includes(file.status)));
}

function renderShipping() {
  renderLanes('shippingLanes', filteredFiles().filter((file) => ['Complete', 'Shipped'].includes(file.status)), [...laneNames, 'Shipped']);
}

function renderUsers() {
  if (!canManageUsers() || !$('userRows')) return;
  $('usersMessage').textContent = users.length ? `${users.length} user${users.length === 1 ? '' : 's'} found.` : 'No users found.';
  $('userRows').innerHTML = users.map((user) => `
    <tr>
      <td><b>${esc(user.firstName)} ${esc(user.lastName)}</b></td>
      <td>
        <select data-action="update-user-role" data-id="${user.id}" aria-label="Role for ${esc(user.firstName)} ${esc(user.lastName)}">
          ${roles.map((role) => `<option value="${esc(role)}" ${user.role === role ? 'selected' : ''}>${esc(role)}</option>`).join('')}
        </select>
      </td>
      <td>
        <div class="pin-reset">
          <input data-pin-input="${user.id}" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="New PIN" aria-label="New PIN for ${esc(user.firstName)} ${esc(user.lastName)}">
          <button class="btn small secondary" data-action="reset-user-pin" data-id="${user.id}" type="button">Reset PIN</button>
        </div>
      </td>
      <td><span class="muted">${Object.keys(user.permissions || {}).length ? esc(JSON.stringify(user.permissions)) : 'Permissions coming later'}</span></td>
      <td><span class="pill ${user.isLoggedIn ? 'ready' : 'offline'}">${user.isLoggedIn ? 'Logged in' : 'Logged off'}</span></td>
      <td><div class="actions">${hasUserProfile(user) ? `<button class="btn small secondary" data-action="open-profile" data-id="${user.id}" type="button">Profile</button>` : ''}<button class="btn small danger" data-action="delete-user" data-id="${user.id}" type="button" ${user.id === currentUser.id ? 'disabled' : ''}>Remove</button></div></td>
    </tr>
  `).join('') || '<tr><td colspan="6"><div class="empty">No users have signed up yet.</div></td></tr>';
}

function normalizeDeviceName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
}

function deviceMatchesTraining(fileDevice, trainedDevice) {
  const fileValue = normalizeDeviceName(fileDevice);
  const trainedValue = normalizeDeviceName(trainedDevice);
  return Boolean(fileValue && trainedValue && (fileValue.includes(trainedValue) || trainedValue.includes(fileValue)));
}

function trainedDeviceList(user) {
  return Array.isArray(user?.trainedDevices) ? user.trainedDevices.filter(Boolean) : [];
}

function isDeviceOptionSelected(user, option) {
  return trainedDeviceList(user).some((device) => deviceMatchesTraining(device, option));
}

function isTrainedForFile(user, file) {
  return trainedDeviceList(user).some((device) => deviceMatchesTraining(file.device, device));
}

function qualifiedNewHiresForFile(file) {
  return coordinators.filter((user) => user.isNewHire && user.isLoggedIn && isTrainedForFile(user, file));
}

function claimWindowRemainingMs(file) {
  if (file.status !== 'Ready for Prep' || !qualifiedNewHiresForFile(file).length) return 0;
  const start = Date.parse(file.updatedAt || file.createdAt || '');
  if (Number.isNaN(start)) return 0;
  return Math.max(0, newHireClaimWindowMs - (Date.now() - start));
}

function canCoordinatorClaimPrepNow(file, coordinator) {
  if (!coordinator || !isTrainedForFile(coordinator, file)) return false;
  if (coordinator.isNewHire) return true;
  return claimWindowRemainingMs(file) === 0;
}

function scheduleClaimWindowRefresh(file) {
  const remaining = claimWindowRemainingMs(file);
  if (!remaining || claimWindowTimers.has(file.id)) return;
  claimWindowTimers.set(file.id, window.setTimeout(() => {
    claimWindowTimers.delete(file.id);
    render();
    queuePrepReadyNotifications();
  }, remaining + 100));
}

function currentCoordinatorProfile() {
  if (effectiveRole() !== 'Device Coordinator') return null;
  return coordinators.find((user) => user.id === currentUser?.id) || {
    id: currentUser?.id,
    firstName: currentUser?.firstName,
    lastName: currentUser?.lastName,
    trainedDevices: [],
    isNewHire: Boolean(currentUser?.isNewHire),
    isLoggedIn: true
  };
}

function notificationHost() {
  let host = $('prepNotificationHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'prepNotificationHost';
    host.className = 'notification-host';
    document.body.appendChild(host);
  }
  return host;
}

function dismissPrepNotification(fileId) {
  const entry = activePrepNotifications.get(fileId);
  if (entry?.timer) clearTimeout(entry.timer);
  entry?.element?.remove();
  activePrepNotifications.delete(fileId);
}

function sendSidekickPrepNotification(file) {
  if (!window.dashboardSidekick?.notifyPrep) return;
  const client = `${file.last || ''}, ${file.first || ''}`.trim().replace(/^,\s*/, '');
  const crmNumber = crmRecordNumber(file.crm);
  window.dashboardSidekick.notifyPrep({
    id: file.id,
    title: 'Ready for prep',
    message: `${client || 'A client file'} is ready for prep${file.device ? ` on ${file.device}` : ''}.`,
    client,
    device: file.device || '',
    loan: file.loan || '',
    crm: crmNumber || file.crm || ''
  }).catch((error) => console.error('Sidekick notification bridge failed:', error));
}

function showPrepNotification(file) {
  if (activePrepNotifications.has(file.id) || seenPrepNotifications.has(file.id)) return;
  seenPrepNotifications.add(file.id);
  const accessories = fileAccessories(file);
  const toast = document.createElement('div');
  toast.className = 'prep-notification';
  toast.innerHTML = `
    <div class="prep-notification-body">
      <strong>Prep ready: ${esc(file.last)}, ${esc(file.first)}</strong>
      <span>${esc(file.device || 'Device not listed')}</span>
      <div class="file-meta">${esc(file.loan || 'No loan type')} - Ship by ${esc(formatDate(file.expires))}</div>
      <div class="file-card-details">
        <div><span>Vocabulary</span><b>${esc(file.vocab || 'none')}</b></div>
        <div><span>Accessories</span><b>${accessories.length ? accessories.map(esc).join(', ') : 'none'}</b></div>
      </div>
    </div>
    <button class="btn" data-action="claim-prep-notification" data-id="${file.id}" type="button">Claim</button>
  `;
  notificationHost().appendChild(toast);
  sendSidekickPrepNotification(file);
  const timer = setTimeout(() => dismissPrepNotification(file.id), 10000);
  activePrepNotifications.set(file.id, { element: toast, timer });
}

function queuePrepReadyNotifications() {
  const coordinator = currentCoordinatorProfile();
  if (!coordinator) return;
  const openReadyIds = new Set(files.filter((file) => file.status === 'Ready for Prep').map((file) => file.id));
  [...activePrepNotifications.keys()].forEach((fileId) => {
    if (!openReadyIds.has(fileId)) dismissPrepNotification(fileId);
  });
  [...claimWindowTimers.keys()].forEach((fileId) => {
    if (!openReadyIds.has(fileId)) {
      clearTimeout(claimWindowTimers.get(fileId));
      claimWindowTimers.delete(fileId);
    }
  });
  const eligibleFiles = stableFileOrder(files)
    .filter((file) => file.status === 'Ready for Prep' && canCoordinatorClaimPrepNow(file, coordinator));
  if (suppressExistingPrepNotifications) {
    eligibleFiles.forEach((file) => seenPrepNotifications.add(file.id));
    suppressExistingPrepNotifications = false;
    return;
  }
  stableFileOrder(files)
    .filter((file) => file.status === 'Ready for Prep')
    .forEach(scheduleClaimWindowRefresh);
  eligibleFiles.forEach(showPrepNotification);
}

async function claimPrepFromNotification(id) {
  const file = files.find((item) => item.id === id);
  const coordinator = currentCoordinatorProfile();
  if (!file || !coordinator || !canCoordinatorClaimPrepNow(file, coordinator)) {
    dismissPrepNotification(id);
    if (file && coordinator && isTrainedForFile(coordinator, file)) alert('New hires have first claim on this file for a few seconds.');
    return;
  }
  const initials = currentUserInitials();
  const patch = {
    status: `Being prepped by ${initials}`,
    preppedBy: initials,
    preppedById: currentUser.id
  };
  const { data, error } = await withSupabaseRetry(() => supabase
    .from('trial_files')
    .update(fileToRow({ ...file, ...patch }))
    .eq('id', id)
    .eq('status', 'Ready for Prep')
    .select('id')
    .maybeSingle());
  if (error) return showError(error);
  dismissPrepNotification(id);
  if (!data) {
    alert('This prep was already claimed by another coordinator.');
  } else {
    await logFileChanges(id, file, patch);
  }
  await loadData();
}

function renderLeadSchedules() {
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
  return `<div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Role</th>${weekdays.map((day) => `<th>${day}</th>`).join('')}</tr></thead><tbody>${tableRows(users.map((user) => `<tr><td>${esc(userFullName(user))}</td><td>${esc(user.role)}</td>${weekdays.map((day) => `<td>${esc(user.weeklySchedule?.[day] || 'Not listed')}</td>`).join('')}</tr>`), 'No users found.', 7)}</tbody></table></div>`;
}

function renderLeadShipped() {
  const historyIds = new Set(shipmentHistory.map((item) => item.file_id));
  const currentShipped = files
    .filter((file) => file.status === 'Shipped' && !historyIds.has(file.id))
    .map((file) => ({ first_name: file.first, last_name: file.last, device: file.device, loan_type: file.loan, lane: file.lane, shipped_date: 'Current queue' }));
  const rows = [...shipmentHistory, ...currentShipped];
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Client</th><th>Device</th><th>Loan</th><th>Lane</th><th>Shipped date</th></tr></thead><tbody>${tableRows(rows.map((item) => `<tr><td>${esc(item.last_name)}, ${esc(item.first_name)}</td><td>${esc(item.device || 'Not listed')}</td><td>${esc(item.loan_type || 'Not listed')}</td><td>${esc(item.lane || 'Not listed')}</td><td>${item.shipped_date === 'Current queue' ? 'Current queue' : esc(formatDate(item.shipped_date))}</td></tr>`), 'No shipped files have been logged yet.', 5)}</tbody></table></div>`;
}

function renderLeadTraining() {
  return `<div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Role</th><th>New hire</th><th>Trained devices</th></tr></thead><tbody>${tableRows(users.filter(hasUserProfile).map((user) => `<tr><td>${esc(userFullName(user))}</td><td>${esc(user.role)}</td><td>${user.isNewHire ? '<span class="pill prep">Yes</span>' : '<span class="muted">No</span>'}</td><td>${trainedDeviceList(user).map(esc).join(', ') || 'No trained devices listed'}</td></tr>`), 'No trained-device profiles found.', 4)}</tbody></table></div>`;
}

function currentTaskForUser(user) {
  const current = stableFileOrder(files).find((file) => (
    (file.status.startsWith('Being prepped by ') && file.preppedById === user.id) ||
    (file.status.startsWith("Being QA'd by ") && file.qaById === user.id)
  ));
  if (current) return `${current.status}: ${current.last}, ${current.first} (${current.device || 'device not listed'})`;
  const latest = teamActivity
    .filter((item) => item.user_id === user.id)
    .sort((a, b) => String(b.latest_at || '').localeCompare(String(a.latest_at || '')))[0];
  return latest ? `${formatAction(latest.action)} on ${formatDate(latest.activity_date)}` : 'No recent action';
}

function renderLeadCurrentTasks() {
  return `<div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Role</th><th>Current task / most recent action</th></tr></thead><tbody>${tableRows(users.map((user) => `<tr><td>${esc(userFullName(user))}</td><td>${esc(user.role)}</td><td>${esc(currentTaskForUser(user))}</td></tr>`), 'No users found.', 3)}</tbody></table></div>`;
}

function renderLeadWeeklyUserTotals() {
  const weekStart = mondayOf();
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 4);
  const start = isoDate(weekStart);
  const end = isoDate(weekEnd);
  const range = formatDateRange(start, isoDate(weekEnd));
  const rows = users.map((user) => {
    const prep = teamActivity.filter((item) => item.user_id === user.id && item.action === 'prep_completed' && item.activity_date >= start && item.activity_date <= end).reduce((total, item) => total + Number(item.count || 0), 0);
    const qa = teamActivity.filter((item) => item.user_id === user.id && item.action === 'qa_completed' && item.activity_date >= start && item.activity_date <= end).reduce((total, item) => total + Number(item.count || 0), 0);
    return `<tr><td>${esc(userFullName(user))}</td><td>${esc(user.role)}</td><td>${prep}</td><td>${qa}</td><td>${prep + qa}</td></tr>`;
  });
  return `<section class="profile-panel"><h3>Weekly User Totals</h3><div class="muted">Date range: ${esc(range)}</div><div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Role</th><th>Preps this week</th><th>QA this week</th><th>Total</th></tr></thead><tbody>${tableRows(rows, 'No users found.', 5)}</tbody></table></div></section>`;
}

function shipmentTotals(periodForDate, field) {
  const totals = {};
  shipmentHistory.forEach((item) => {
    const period = periodForDate(item.shipped_date);
    const label = item[field] || 'Not listed';
    const key = `${period.key}||${label}`;
    totals[key] = { period: period.label, sortKey: period.key, label, count: (totals[key]?.count || 0) + 1 };
  });
  return Object.values(totals).sort((a, b) => b.sortKey.localeCompare(a.sortKey) || b.count - a.count || a.label.localeCompare(b.label));
}

function totalsTable(title, rows) {
  return `<section class="profile-panel"><h3>${title}</h3><div class="table-wrap"><table class="table"><thead><tr><th>Date range</th><th>Type</th><th>Sent</th></tr></thead><tbody>${tableRows(rows.map((row) => `<tr><td>${esc(row.period)}</td><td>${esc(row.label)}</td><td>${row.count}</td></tr>`), 'No shipment totals yet.', 3)}</tbody></table></div></section>`;
}

function renderLeadShipmentTotals() {
  return `<div class="profile-grid">${totalsTable('Weekly loan type totals', shipmentTotals(weeklyPeriod, 'loan_type'))}${totalsTable('Monthly loan type totals', shipmentTotals(monthlyPeriod, 'loan_type'))}${totalsTable('Weekly device type totals', shipmentTotals(weeklyPeriod, 'device'))}${totalsTable('Monthly device type totals', shipmentTotals(monthlyPeriod, 'device'))}</div>`;
}

function objectTotalsTable(title, totals) {
  const rows = Object.entries(totals || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return `<section class="profile-panel"><h3>${title}</h3><table class="table"><thead><tr><th>Type</th><th>Total</th></tr></thead><tbody>${tableRows(rows.map(([label, count]) => `<tr><td>${esc(label)}</td><td>${count}</td></tr>`), 'No totals logged.', 2)}</tbody></table></section>`;
}

function renderLeadCleanups() {
  return `<div class="profile-grid">${eodCleanups.map((cleanup) => `
    <details class="profile-panel cleanup-report">
      <summary><div><h3>${esc(formatDate(cleanup.cleanup_date))}</h3><div class="muted">${cleanup.file_count || 0} shipped file${cleanup.file_count === 1 ? '' : 's'} cleaned up</div></div><span class="muted">Open report</span></summary>
      <div class="cleanup-report-body">
        <div class="footer"><button class="btn small danger" data-action="delete-cleanup" data-id="${cleanup.id}" type="button">Delete report</button></div>
        <div class="cleanup-grid">
          ${objectTotalsTable('Loan types', cleanup.loan_totals)}
          ${objectTotalsTable('Device types', cleanup.device_totals)}
          ${objectTotalsTable('Accessory types', cleanup.accessory_totals)}
        </div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Client</th><th>Device</th><th>Loan</th><th>Accessories</th></tr></thead><tbody>${tableRows((cleanup.files || []).map((file) => `<tr><td>${esc(file.lastName)}, ${esc(file.firstName)}</td><td>${esc(file.device || 'Not listed')}</td><td>${esc(file.loan || 'Not listed')}</td><td>${(file.accessories || []).map(esc).join(', ') || 'None listed'}</td></tr>`), 'No file details logged.', 4)}</tbody></table></div>
      </div>
    </details>
  `).join('') || '<div class="empty">No end-of-day cleanups have been logged.</div>'}</div>`;
}

function renderLeadReportActions() {
  const reportCount = shipmentHistory.length + eodCleanups.length;
  return canManageUsers()
    ? `<div class="report-actions"><button class="btn secondary" data-action="export-daily-reports" type="button" ${shipmentHistory.length ? '' : 'disabled'}>Export daily reports to Excel</button><button class="btn danger" data-action="delete-lead-reports" type="button" ${reportCount ? '' : 'disabled'}>Delete all lead reports</button><span class="muted">${reportCount} saved report record${reportCount === 1 ? '' : 's'}</span></div>`
    : '';
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadTextFile(filename, content, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportDailyReports() {
  if (!canManageUsers() || !shipmentHistory.length) return;
  const headers = ['Shipped date', 'Client', 'Device', 'Loan type', 'Lane'];
  const rows = shipmentHistory
    .slice()
    .sort((a, b) => String(b.shipped_date || '').localeCompare(String(a.shipped_date || '')) || `${a.last_name || ''}, ${a.first_name || ''}`.localeCompare(`${b.last_name || ''}, ${b.first_name || ''}`))
    .map((item) => [
      formatDate(item.shipped_date),
      `${item.last_name || ''}, ${item.first_name || ''}`.trim(),
      item.device || 'Not listed',
      item.loan_type || 'Not listed',
      item.lane || 'Not listed'
    ]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  downloadTextFile(`daily-reports-${todayLocalDate()}.csv`, csv);
}

function renderLeadDashboard() {
  if (!$('leadDashboardBody')) return;
  if (['queue', 'shipped', 'current'].includes(leadTab)) leadTab = 'schedules';
  const renderers = {
    schedules: renderLeadSchedules,
    training: renderLeadTraining,
    weekly: renderLeadWeeklyUserTotals,
    totals: renderLeadShipmentTotals,
    cleanups: renderLeadCleanups
  };
  $('leadDashboardBody').innerHTML = `
    ${renderLeadReportActions()}
    ${(renderers[leadTab] || renderLeadSchedules)()}
  `;
}

function userInitials(user = profileUser) {
  return `${user?.firstName?.[0] || ''}${user?.lastName?.[0] || ''}`.toUpperCase();
}

function mondayOf(date = new Date()) {
  const copy = new Date(date);
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function todayLocalDate() {
  const today = new Date();
  const offset = today.getTimezoneOffset() * 60000;
  return new Date(today.getTime() - offset).toISOString().slice(0, 10);
}

function activityCount(action, date) {
  return profileActivity
    .filter((item) => item.action === action && item.activity_date === date)
    .reduce((total, item) => total + Number(item.count || 0), 0);
}

function profileClaimedJobs() {
  if (!profileUser) return [];
  return files.filter((file) => (
    (file.status.startsWith('Being prepped by ') && file.preppedById === profileUser.id) ||
    (file.status.startsWith("Being QA'd by ") && file.qaById === profileUser.id)
  ));
}

function profileCompletedCount(kind) {
  const action = kind === 'prep' ? 'prep_completed' : 'qa_completed';
  const activityTotal = profileActivity
    .filter((item) => item.action === action)
    .reduce((total, item) => total + Number(item.count || 0), 0);
  if (activityTotal) return activityTotal;
  const initials = userInitials(profileUser);
  return files.filter((file) => {
    if (kind === 'prep') return (file.preppedById === profileUser.id || file.preppedBy === initials) && ['Ready for QA', 'Complete', 'Shipped'].includes(file.status);
    return (file.qaById === profileUser.id || file.qaBy === initials) && ['Complete', 'Shipped'].includes(file.status);
  }).length;
}

function sidekickLogDetail(log) {
  const detail = log.detail || '';
  const metadata = log.metadata && typeof log.metadata === 'object' ? log.metadata : {};
  const target = metadata.target || metadata.button || metadata.view || '';
  return [detail, target && `Target: ${target}`].filter(Boolean).join(' | ') || 'none';
}

function renderSidekickProfilePanel() {
  const rows = profileSidekickLogs.map((log) => `
    <tr>
      <td>${esc(formatDateTime(log.occurred_at || log.created_at))}</td>
      <td>${esc(log.action || 'Sidekick action')}</td>
      <td>${esc(sidekickLogDetail(log))}</td>
    </tr>
  `);

  return `
    <section class="profile-panel">
      <div class="preprep-head">
        <div>
          <h3>Sidekick Link</h3>
          <div class="muted">Link the browser Sidekick to this dashboard profile, then Sidekick clicks and workflow actions will appear below.</div>
        </div>
        <button class="btn secondary" data-action="link-sidekick-profile" data-id="${profileUser.id}" type="button">Link Sidekick to this profile</button>
      </div>
      <div id="sidekickLinkMessage" class="muted">Open this profile in the dashboard, click the link button, then use the Sidekick link control in the extension.</div>
      <h3>Sidekick Log</h3>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Time</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>${tableRows(rows, 'No Sidekick actions logged yet.', 3)}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderProfile() {
  if (!$('profileBody')) return;
  if (!profileUser) {
    $('profileName').textContent = 'Profile';
    $('profileRole').textContent = '';
    $('profileBody').innerHTML = '<div class="empty">Open a profile to view details.</div>';
    return;
  }
  $('profileName').textContent = `${profileUser.firstName} ${profileUser.lastName}`;
  $('profileRole').textContent = profileUser.role;
  const isCoordinatorProfile = profileUser.role === 'Device Coordinator';
  const weekStart = mondayOf();
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((day, index) => {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + index);
    const key = isoDate(date);
    return { day, key, prep: activityCount('prep_completed', key), qa: activityCount('qa_completed', key), schedule: profileUser.weeklySchedule?.[day.toLowerCase()] || '' };
  });
  const claimed = profileClaimedJobs();
  const trainedDevices = trainedDeviceList(profileUser);
  const canToggleNewHire = canActivateNewHireMode();
  $('profileBody').innerHTML = `
    <div class="profile-grid">
      ${isCoordinatorProfile ? `
      <section class="profile-panel">
        <h3>Mini Dashboard</h3>
        <div class="stats compact">
          <div class="card stat"><b>${claimed.length}</b><span>Claimed jobs</span></div>
          <div class="card stat"><b>${profileCompletedCount('prep')}</b><span>Completed preps</span></div>
          <div class="card stat"><b>${profileCompletedCount('qa')}</b><span>Completed QA</span></div>
        </div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Claimed job</th><th>Status</th><th>Ship by</th></tr></thead><tbody>${claimed.map((file) => `<tr><td>${esc(file.last)}, ${esc(file.first)}</td><td>${esc(file.status)}</td><td>${esc(formatDate(file.expires))}</td></tr>`).join('') || '<tr><td colspan="3"><div class="empty">No claimed jobs.</div></td></tr>'}</tbody></table></div>
      </section>
      <section class="profile-panel">
        <h3>Weekly Totals</h3>
        <table class="table"><thead><tr><th>Day</th><th>Preps</th><th>QA</th></tr></thead><tbody>${weekdays.map((item) => `<tr><td>${item.day}</td><td>${item.prep}</td><td>${item.qa}</td></tr>`).join('')}</tbody></table>
      </section>` : ''}
      <section class="profile-panel">
        <h3>Weekly Schedule</h3>
        <div class="form schedule-form">${weekdays.map((item) => `<div class="field"><label for="schedule-${item.day}">${item.day}</label><input id="schedule-${item.day}" data-schedule-day="${item.day.toLowerCase()}" value="${esc(item.schedule)}" placeholder="8:00 AM - 4:30 PM"></div>`).join('')}</div>
        <div class="footer"><button class="btn" data-action="save-profile-schedule" data-id="${profileUser.id}" type="button">Save schedule</button></div>
      </section>
      <section class="profile-panel">
        <h3>Trained Devices</h3>
        <div class="trained-list">${trainedDevices.map((device) => `<span class="pill ready">${esc(device)}</span>`).join('') || '<div class="empty">No trained devices listed.</div>'}</div>
        <div class="option-grid">
          ${trainedDeviceOptions.map((device) => `<label class="check-card"><input type="checkbox" data-trained-device="${esc(device)}" ${isDeviceOptionSelected(profileUser, device) ? 'checked' : ''}> <span>${esc(device)}</span></label>`).join('')}
        </div>
        <label class="check-row new-hire-toggle"><input id="profileNewHire" type="checkbox" ${profileUser.isNewHire ? 'checked' : ''} ${canToggleNewHire ? '' : 'disabled'}> New hire</label>
        <span class="muted">${canToggleNewHire ? 'Prep notifications only show for matching trained devices. New hires get the first claim window before the rest of the team.' : 'Only Lead users can activate or deactivate new hire mode.'}</span>
        <div class="footer"><button class="btn" data-action="save-trained-devices" data-id="${profileUser.id}" type="button">Save training</button></div>
      </section>
      ${profileUser.id === currentUser.id ? `
      <section class="profile-panel">
        <h3>Change PIN</h3>
        <div class="form">
          <div class="field"><label for="profileCurrentPin">Current PIN</label><input id="profileCurrentPin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4"></div>
          <div class="field"><label for="profileNewPin">New PIN</label><input id="profileNewPin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4"></div>
        </div>
        <div class="footer"><button class="btn" data-action="change-own-pin" type="button">Change PIN</button></div>
      </section>` : ''}
      ${renderSidekickProfilePanel()}
    </div>
  `;
}

function duplicateCrmNeedsNote(item) {
  if (!/^\d{5}$/.test(item.usedOn)) return false;
  const matches = gipodCodes.filter((other) => other.usedOn === item.usedOn);
  return matches.length > 1 && !matches.some((other) => other.note?.trim());
}

function renderPrePrep() {
  const allRows = stableFileOrder(filteredFiles().filter(isPrePrep));
  const rows = prepperFilter === 'All' ? allRows : allRows.filter((file) => file.prepper === prepperFilter);
  const existingIds = new Set(files.filter(isPrePrep).map((file) => file.id));
  selectedFileIds = new Set([...selectedFileIds].filter((id) => existingIds.has(id)));
  const tabs = ['All', ...specialistNames()];
  if (prepperFilter !== 'All' && !tabs.includes(prepperFilter)) prepperFilter = 'All';
  $('prepperTabs').innerHTML = tabs.map((name) => `<button class="tab ${prepperFilter === name ? 'active' : ''}" data-action="prepper-filter" data-name="${esc(name)}">${esc(name)} <span class="count">${name === 'All' ? allRows.length : allRows.filter((file) => file.prepper === name).length}</span></button>`).join('');
  $('preprepRows').innerHTML = rows.map((file) => {
    const crmNumber = crmRecordNumber(file.crm);
    const gipodCell = file.gipod
      ? esc(file.gipod)
      : `<button class="btn small secondary" data-action="claim-gipod" data-id="${file.id}">Get next code</button>`;
    const specialistCell = file.prepper
      ? `<span class="pill prep">${esc(file.prepper)}</span>`
      : currentUser?.role === 'Device Systems Specialist'
        ? `<button class="btn small secondary" data-action="claim-file" data-id="${file.id}">Claim</button>`
        : '<span class="muted">Unclaimed</span>';
    const accessories = fileAccessories(file);
    const laneSelect = `<select class="inline-select" data-action="assign-lane" data-id="${file.id}" aria-label="Lane for ${esc(file.last)}, ${esc(file.first)}">${laneNames.map((lane) => `<option value="${esc(lane)}" ${file.lane === lane ? 'selected' : ''}>${esc(lane)}</option>`).join('')}</select>`;
    const deviceNumberInput = canEditFiles()
      ? `<input class="inline-text-input" data-action="update-device-number" data-id="${file.id}" value="${esc(file.deviceNumber || '')}" placeholder="Device #">`
      : esc(file.deviceNumber || 'none');
    return `<tr class="clickable" data-action="open-file" data-id="${file.id}"><td class="select-cell"><input type="checkbox" data-action="select-file" data-id="${file.id}" aria-label="Select ${esc(file.last)}, ${esc(file.first)}" ${selectedFileIds.has(file.id) ? 'checked' : ''}></td><td class="client-name">${esc(file.last)}, ${esc(file.first)}</td><td><span class="crm-number">${esc(crmNumber || 'none')}</span></td><td>${esc(file.device)}</td><td>${deviceNumberInput}</td><td>${esc(file.vocab || 'none')}</td><td>${gipodCell}</td><td>${esc(file.loan || 'none')}</td><td>${laneSelect}</td><td class="compact-text">${accessories.length ? accessories.map(esc).join(', ') : 'none'}</td><td class="note-preview">${esc(file.notes || 'none')}</td><td>${specialistCell}</td><td><span class="pill ${statusClass(file)}">${esc(file.status)}</span></td><td>${esc(formatDate(file.date))}</td><td><div class="actions"><button class="btn small secondary" data-action="ready-for-prep" data-id="${file.id}">Mark Ready for Prep</button><button class="btn small danger" data-action="delete-file" data-id="${file.id}">Delete</button>${actionButtons(file)}</div></td></tr>`;
  }).join('') || '<tr><td colspan="15"><div class="empty">No devices are ready for pre-prep in this tab.</div></td></tr>';
  const visibleIds = rows.map((file) => file.id);
  const selectAll = $('selectAllFiles');
  selectAll.checked = visibleIds.length > 0 && visibleIds.every((id) => selectedFileIds.has(id));
  selectAll.indeterminate = visibleIds.some((id) => selectedFileIds.has(id)) && !selectAll.checked;
  const bulkDeleteButton = $('bulkDeleteFilesButton');
  bulkDeleteButton.textContent = `Delete selected (${selectedFileIds.size})`;
  bulkDeleteButton.disabled = selectedFileIds.size === 0;
  if ($('code-tab-unused')) $('code-tab-unused').classList.toggle('active', codeTab === 'unused');
  if ($('code-tab-used')) $('code-tab-used').classList.toggle('active', codeTab === 'used');
  if ($('unusedCodeCount')) $('unusedCodeCount').textContent = gipodCodes.filter((item) => !item.usedOn).length;
  if ($('usedCodeCount')) $('usedCodeCount').textContent = gipodCodes.filter((item) => item.usedOn).length;
  const visibleCodes = gipodCodes.filter((item) => codeTab === 'used' ? item.usedOn : !item.usedOn);
  $('gipodRows').innerHTML = visibleCodes.map((item) => {
    const missingDuplicateNote = duplicateCrmNeedsNote(item);
    return `<tr class="${missingDuplicateNote ? 'duplicate-crm' : ''}"><td><b>${esc(item.code)}</b></td><td><span class="pill ${item.usedOn ? 'prep' : 'ready'}">${item.usedOn ? 'Used' : 'Available'}</span></td><td>${esc(item.usedOn || 'none')}${missingDuplicateNote ? '<span class="duplicate-warning">Duplicate CRM - add one note</span>' : ''}</td><td>${esc(formatDate(item.usedDate))}</td><td><textarea class="note-input" data-code-note="${item.id}" aria-label="GIPOD note for ${esc(item.code)}">${esc(item.note || '')}</textarea></td><td><div class="actions"><button class="btn small secondary" data-action="save-code-note" data-id="${item.id}" type="button">Save note</button><button class="btn small ${item.usedOn ? 'secondary' : ''}" data-action="use-code" data-id="${item.id}" type="button">${item.usedOn ? 'Edit usage' : 'Use code'}</button></div></td></tr>`;
  }).join('') || `<tr><td colspan="6"><div class="empty">No ${codeTab === 'used' ? 'used' : 'unused'} GIPOD codes.</div></td></tr>`;
}

function renderCurrentView() {
  renderStats();
  if (view === 'leadDashboard') renderLeadDashboard();
  if (view === 'dashboard') renderDashboard();
  if (view === 'preprep') renderPrePrep();
  if (view === 'shipping') renderShipping();
  if (view === 'users') renderUsers();
  if (view === 'profile') renderProfile();
}

function render() {
  normalizeView();
  const titles = {
    dashboard: ['Shared Dashboard', 'One file and device queue for the whole team.'],
    leadDashboard: ['Lead Dashboard', 'Team schedules, training, queue status, shipped history, and persistent totals.'],
    preprep: ['Device Systems Dashboard', 'Claim and prepare incoming files through the shared device queue.'],
    shipping: ['Shipping', 'Completed devices ready for shipping.'],
    users: ['User Management', 'Adjust user roles and prepare permissions for the team.'],
    profile: ['Profile', 'Review claimed work, weekly totals, schedule, and PIN settings.']
  };
  $('viewTitle').textContent = titles[view][0];
  $('viewSub').textContent = titles[view][1];
  ['leadDashboard', 'dashboard', 'preprep', 'shipping', 'users', 'profile'].forEach((name) => {
    const viewElement = $(`${name}View`);
    const navElement = $(`nav-${name}`);
    if (viewElement) viewElement.classList.toggle('hide', view !== name);
    if (navElement) navElement.classList.toggle('active', view === name);
  });
  ['files', 'codes'].forEach((tab) => $(`tab-${tab}`).classList.toggle('active', prepTab === tab));
  $('prepFilesPanel').classList.toggle('hide', prepTab !== 'files');
  $('prepCodesPanel').classList.toggle('hide', prepTab !== 'codes');
  $('bulkFilesButton').classList.toggle('hide', prepTab !== 'files');
  $('bulkDeleteFilesButton').classList.toggle('hide', prepTab !== 'files');
  $('bulkCodesButton').classList.toggle('hide', prepTab !== 'codes');
  ['schedules', 'training', 'weekly', 'totals', 'cleanups'].forEach((tab) => {
    const tabElement = $(`lead-tab-${tab}`);
    if (tabElement) tabElement.classList.toggle('active', leadTab === tab);
  });
  setConnection(connectionState === 'Live' ? 'Live' : 'Connecting', connectionState);
  renderCurrentView();
}

function setView(next) {
  if (!canView(next)) return;
  view = next;
  render();
}

async function openProfile(userId) {
  if (userId !== currentUser.id && !canManageUsers()) return;
  const user = userId === currentUser.id ? currentUser : users.find((item) => item.id === userId);
  if (user && !hasUserProfile(user)) return;
  await loadProfile(userId);
  view = 'profile';
  render();
}

function setPrepTab(tab) {
  prepTab = tab;
  render();
}

function setCodeTab(tab) {
  codeTab = tab === 'used' ? 'used' : 'unused';
  renderPrePrep();
}

function setLeadTab(tab) {
  leadTab = tab;
  render();
}

function setPrepperFilter(name) {
  prepperFilter = name;
  render();
}

async function claimFile(id) {
  if (currentUser?.role !== 'Device Systems Specialist') {
    alert('Only Device Systems Specialist users can claim files.');
    return;
  }
  await updateFile(id, { prepper: currentUserName() });
}

async function updateUserRole(userId, role) {
  if (!canManageUsers() || !roles.includes(role)) return;
  const { error } = await supabase.rpc('update_app_user_role', {
    p_actor_id: currentUser.id,
    p_user_id: userId,
    p_role: role
  });
  if (error) return showError(error);
  await loadSpecialists();
  await loadUsers();
}

async function createUser(event) {
  event.preventDefault();
  if (!canManageUsers()) return;
  const firstName = $('newUserFirst').value.trim();
  const lastName = $('newUserLast').value.trim();
  const pin = $('newUserPin').value.trim();
  const role = $('newUserRole').value;
  if (!firstName || !lastName || !/^\d{4}$/.test(pin)) {
    alert('Enter first name, last name, and a unique 4-digit PIN.');
    return;
  }
  const { error } = await supabase.rpc('create_app_user', {
    p_actor_id: currentUser.id,
    p_first_name: firstName,
    p_last_name: lastName,
    p_pin: pin,
    p_role: role
  });
  if (error) return showError(error);
  $('createUserForm').reset();
  await loadSpecialists();
  await loadUsers();
}

async function deleteUser(userId) {
  if (!canManageUsers()) return;
  const user = users.find((item) => item.id === userId);
  if (!user || user.id === currentUser.id) return;
  if (!confirm(`Remove ${user.firstName} ${user.lastName}? This will remove their login and profile history.`)) return;
  const { error } = await supabase.rpc('delete_app_user', {
    p_actor_id: currentUser.id,
    p_user_id: userId
  });
  if (error) return showError(error);
  if (selectedProfileId === userId) {
    selectedProfileId = '';
    profileUser = null;
    profileActivity = [];
    profileSidekickLogs = [];
    view = canView('users') ? 'users' : firstAllowedView();
  }
  await loadSpecialists();
  await loadUsers();
  render();
}

async function resetUserPin(userId) {
  if (!canManageUsers()) return;
  const input = document.querySelector(`[data-pin-input="${CSS.escape(userId)}"]`);
  const pin = input?.value.trim() || '';
  if (!/^\d{4}$/.test(pin)) {
    alert('Enter a new PIN with exactly 4 digits.');
    return;
  }
  const { error } = await supabase.rpc('update_app_user_pin', {
    p_actor_id: currentUser.id,
    p_user_id: userId,
    p_pin: pin
  });
  if (error) return showError(error);
  input.value = '';
  alert('PIN updated.');
}

async function saveGipodNote(id) {
  const input = document.querySelector(`[data-code-note="${CSS.escape(id)}"]`);
  if (!input) return;
  await updateGipod(id, { note: input.value.trim() });
}

async function changeOwnPin() {
  const currentPin = $('profileCurrentPin')?.value.trim() || '';
  const newPin = $('profileNewPin')?.value.trim() || '';
  if (!/^\d{4}$/.test(currentPin) || !/^\d{4}$/.test(newPin)) {
    alert('Both PIN fields must be exactly 4 digits.');
    return;
  }
  const { data, error } = await supabase.rpc('update_own_app_user_pin', {
    p_user_id: currentUser.id,
    p_current_pin: currentPin,
    p_new_pin: newPin
  });
  if (error) return showError(error);
  persistCurrentUser({ ...currentUser, ...data });
  $('profileCurrentPin').value = '';
  $('profileNewPin').value = '';
  alert('PIN changed.');
}

async function saveProfileSchedule(userId) {
  if (userId !== currentUser.id && !canManageUsers()) return;
  const schedule = {};
  document.querySelectorAll('[data-schedule-day]').forEach((input) => {
    schedule[input.dataset.scheduleDay] = input.value.trim();
  });
  const { data, error } = await supabase.rpc('update_app_user_schedule', {
    p_actor_id: currentUser.id,
    p_user_id: userId,
    p_schedule: schedule
  });
  if (error) return showError(error);
  profileUser = data;
  alert('Schedule saved.');
  renderProfile();
}

async function linkSidekickProfile(userId) {
  if (!window.dashboardSidekick?.setProfile) {
    alert('Sidekick linking is only available in the installed dashboard app.');
    return;
  }
  if (!profileUser || profileUser.id !== userId) return;
  const linked = await window.dashboardSidekick.setProfile({
    id: profileUser.id,
    name: userFullName(profileUser),
    role: profileUser.role
  }).catch((error) => {
    console.error('Unable to link Sidekick profile:', error);
    return null;
  });
  const message = $('sidekickLinkMessage');
  if (message) {
    message.className = linked ? 'success' : 'error';
    message.textContent = linked
      ? `${userFullName(profileUser)} is ready to link in CRM Sidekick. Open Sidekick and choose Link Dashboard Profile.`
      : 'Unable to prepare the Sidekick link.';
  }
}

async function saveTrainedDevices(userId) {
  if (userId !== currentUser.id && !canManageUsers()) return;
  const trainedDevices = [...document.querySelectorAll('[data-trained-device]:checked')]
    .map((input) => input.dataset.trainedDevice)
    .filter(Boolean);
  const uniqueDevices = [...new Set(trainedDevices)];
  const nextIsNewHire = Boolean($('profileNewHire')?.checked);
  if (nextIsNewHire !== Boolean(profileUser?.isNewHire) && !canActivateNewHireMode()) {
    alert('Only Lead users can activate or deactivate new hire mode.');
    renderProfile();
    return;
  }
  const { data, error } = await supabase.rpc('update_app_user_trained_devices', {
    p_actor_id: currentUser.id,
    p_user_id: userId,
    p_trained_devices: uniqueDevices,
    p_is_new_hire: nextIsNewHire
  });
  if (error) return showError(error);
  profileUser = data;
  if (userId === currentUser.id) persistCurrentUser({ ...currentUser, trainedDevices: data.trainedDevices || [], isNewHire: Boolean(data.isNewHire) });
  await loadData();
  alert('Training saved.');
}

function laneForLoan(loan, fallback = 'Daily Queue') {
  const type = loan.trim().toUpperCase();
  if (type === 'FR') return 'Funded Rentals';
  if (type === 'SL') return 'Expedites';
  return fallback;
}

function priorityForLane(lane) {
  return lane === 'Expedites' ? 'EXPEDITE' : 'Normal';
}

function actorName() {
  return currentUserName() || 'Unknown user';
}

async function addFileLog(fileId, action, fieldName = '', oldValue = '', newValue = '') {
  if (!fileId) return;
  const { error } = await supabase.from('app_file_logs').insert({
    file_id: fileId,
    actor_user_id: currentUser?.id || null,
    actor_name: actorName(),
    action,
    field_name: fieldName,
    old_value: displayValue(oldValue),
    new_value: displayValue(newValue)
  });
  if (error) console.error('File log insert failed:', error);
}

async function logFileChanges(fileId, current, patch) {
  if (!current) return;
  const labels = {
    last: 'Last name',
    first: 'First name',
    device: 'Device',
    deviceNumber: 'Device number',
    gipod: 'GIPOD code',
    cameraNumber: 'Camera 1',
    cameraNumber2: 'Camera 2',
    cameraNumber3: 'Camera 3',
    cameraNumber4: 'Camera 4',
    loan: 'Loan type',
    date: 'Queue date',
    expires: 'Ship by date',
    vocab: 'Vocabulary',
    status: 'Status',
    lane: 'Lane',
    crm: 'CRM link',
    notes: 'Notes',
    prepper: 'Specialist',
    preppedBy: 'Prepped by',
    qaBy: 'QA by'
  };
  const rows = Object.entries(patch)
    .filter(([key]) => labels[key])
    .filter(([key, value]) => displayValue(current[key]) !== displayValue(value))
    .map(([key, value]) => ({
      file_id: fileId,
      actor_user_id: currentUser?.id || null,
      actor_name: actorName(),
      action: `${labels[key]} changed`,
      field_name: labels[key],
      old_value: displayValue(current[key]),
      new_value: displayValue(value)
    }));
  if (!rows.length) return;
  const { error } = await supabase.from('app_file_logs').insert(rows);
  if (error) console.error('File log insert failed:', error);
}

function needsGipod(file) {
  const vocab = file.vocab.toLowerCase();
  const device = file.device.toLowerCase();
  return (vocab.includes('grid') || vocab.includes('main 4')) && (device.includes('talk pad') || device.includes('wego'));
}

function crmRecordNumber(link) {
  return link.match(/(\d{5})(?:\D*)$/)?.[1] || '';
}

async function claimNextGipodCode(fileId) {
  const file = files.find((item) => item.id === fileId);
  if (!file) return;
  const crmNumber = crmRecordNumber(file.crm);
  if (!crmNumber) {
    alert('Add a CRM link ending in the 5-digit CRM number before claiming a GIPOD code.');
    return;
  }

  const { data, error } = await withSupabaseRetry(() => supabase.rpc('claim_next_gipod_code', {
    p_file_id: fileId,
    p_crm_number: crmNumber,
    p_used_date: todayLocalDate()
  }));

  if (error) return showError(error);
  if (!data) {
    alert('No available GIPOD codes are left.');
    return;
  }
  await addFileLog(fileId, 'GIPOD code assigned', 'GIPOD code', file.gipod || 'none', data);
  await loadData();
}

function syncLaneFromLoan() {
  const forced = laneForLoan($('editLoan').value, '');
  if (forced) $('editLane').value = forced;
}

function syncLaneFromShipBy() {
  if ($('editExpires').value) $('editLane').value = 'Ship Requested';
}

function setFileTab(tab) {
  activeFileTab = tab === 'log' ? 'log' : 'details';
  $('file-tab-details')?.classList.toggle('active', activeFileTab === 'details');
  $('file-tab-log')?.classList.toggle('active', activeFileTab === 'log');
  $('fileDetailsPanel')?.classList.toggle('hide', activeFileTab !== 'details');
  $('fileLogPanel')?.classList.toggle('hide', activeFileTab !== 'log');
}

function renderFileLogPanel() {
  const panel = $('fileLogPanel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Date</th><th>User</th><th>Action</th><th>Old</th><th>New</th></tr></thead>
        <tbody>${tableRows(fileLogs.map((item) => `<tr><td>${esc(formatDateTime(item.created_at))}</td><td>${esc(item.actor_name || 'Unknown')}</td><td>${esc(item.action || item.field_name || 'Change')}</td><td>${esc(item.old_value || 'none')}</td><td>${esc(item.new_value || 'none')}</td></tr>`), 'No action log yet.', 5)}</tbody>
      </table>
    </div>
  `;
}

function renderCameraFields(file = {}) {
  const values = [file.cameraNumber2, file.cameraNumber3, file.cameraNumber4].map((value) => value || '');
  const visibleCount = values.reduce((count, value, index) => value || index < count ? index + 1 : count, 0);
  $('cameraFields').innerHTML = values.map((value, index) => `
    <div class="field camera-extra ${index >= visibleCount ? 'hide' : ''}" data-camera-field="${index + 2}">
      <label for="editCameraNumber${index + 2}">Camera ${index + 2}</label>
      <input id="editCameraNumber${index + 2}" value="${esc(value)}" placeholder="Camera asset number">
    </div>
  `).join('');
  $('addCameraButton').classList.toggle('hide', visibleCount >= 3);
}

function addCameraField() {
  const next = [...document.querySelectorAll('.camera-extra.hide')][0];
  if (next) next.classList.remove('hide');
  $('addCameraButton').classList.toggle('hide', document.querySelectorAll('.camera-extra.hide').length === 0);
}

function openFile(id) {
  const file = files.find((item) => item.id === id);
  if (!file) return;
  activeFileTab = 'details';
  fileLogs = [];
  const editable = canEditFiles();
  $('editId').value = file.id;
  $('fileModalTitle').textContent = `${file.last}, ${file.first}`;
  const statusSelect = $('editStatus');
  if (![...statusSelect.options].some((option) => option.value === file.status)) {
    statusSelect.add(new Option(file.status, file.status));
  }
  const fields = {
    Last: file.last,
    First: file.first,
    Device: file.device,
    DeviceNumber: file.deviceNumber,
    Gipod: file.gipod,
    CameraNumber: file.cameraNumber,
    Loan: file.loan,
    Date: file.date,
    Expires: file.expires,
    Vocab: file.vocab,
    Status: file.status,
    Lane: file.lane,
    Crm: file.crm,
    Notes: file.notes
  };
  Object.entries(fields).forEach(([key, value]) => {
    $(`edit${key}`).value = value || '';
  });
  renderCameraFields(file);
  if (file.expires && (!file.lane || file.lane === 'Daily Queue')) $('editLane').value = 'Ship Requested';
  $('editCrmButton').href = file.crm || '#';
  $('editCrmButton').classList.toggle('hide', !file.crm);
  $('fileForm').querySelectorAll('input, select, textarea, button[type="submit"]').forEach((control) => {
    control.disabled = !editable;
  });
  $('addCameraButton').disabled = !editable || document.querySelectorAll('.camera-extra.hide').length === 0;
  $('unassignFileButton').disabled = !editable;
  $('fileModal').querySelector('[data-action="close-dialog"]').disabled = false;
  setFileTab('details');
  renderFileLogPanel();
  $('fileModal').showModal();
  loadFileLogs(file.id);
}

async function updateFile(id, patch, reload = true) {
  const current = files.find((item) => item.id === id);
  const row = fileToRow({ ...current, ...patch });
  const { error } = await withSupabaseRetry(() => supabase.from('trial_files').update(row).eq('id', id));
  if (error) return showError(error);
  await logFileChanges(id, current, patch);
  if (reload) await loadData();
}

async function saveDeviceNumber(id, value) {
  const current = files.find((item) => item.id === id);
  if (!current || (current.deviceNumber || '') === value) return;
  const previousValue = current.deviceNumber || '';
  current.deviceNumber = value;
  if ($('editId')?.value === id && $('editDeviceNumber')) $('editDeviceNumber').value = value;
  const { error } = await withSupabaseRetry(() => supabase
    .from('trial_files')
    .update({ device_number: value || '' })
    .eq('id', id));
  if (error) {
    current.deviceNumber = previousValue;
    if ($('editId')?.value === id && $('editDeviceNumber')) $('editDeviceNumber').value = previousValue;
    return showError(error);
  }
  await addFileLog(id, 'Device number changed', 'Device number', previousValue, value);
  await loadData();
}

async function updateGipod(id, patch, reload = true) {
  const current = gipodCodes.find((item) => item.id === id);
  const usedOn = patch.usedOn ?? current.usedOn ?? '';
  const row = {
    code: patch.code ?? current.code,
    used_on: usedOn,
    used_date: usedOn ? (patch.usedDate ?? current.usedDate ?? todayLocalDate()) : null,
    note: patch.note ?? current.note ?? ''
  };
  const { error } = await withSupabaseRetry(() => supabase.from('gipod_codes').update(row).eq('id', id));
  if (error) return showError(error);
  if (reload) await loadData();
}

async function saveFile(event) {
  event.preventDefault();
  if (!canEditFiles()) {
    alert('Device Coordinators can view files and claim work, but cannot edit file fields.');
    return;
  }
  const id = $('editId').value;
  const loan = $('editLoan').value.trim();
  const expires = $('editExpires').value;
  const patch = {
    last: $('editLast').value.trim(),
    first: $('editFirst').value.trim(),
    device: $('editDevice').value.trim(),
    deviceNumber: $('editDeviceNumber').value.trim(),
    gipod: $('editGipod').value.trim(),
    cameraNumber: $('editCameraNumber').value.trim(),
    cameraNumber2: $('editCameraNumber2')?.value.trim() || '',
    cameraNumber3: $('editCameraNumber3')?.value.trim() || '',
    cameraNumber4: $('editCameraNumber4')?.value.trim() || '',
    loan,
    date: $('editDate').value,
    expires,
    vocab: $('editVocab').value.trim(),
    status: $('editStatus').value,
    lane: expires ? 'Ship Requested' : $('editLane').value,
    crm: $('editCrm').value.trim(),
    notes: $('editNotes').value.trim()
  };
  await updateFile(id, patch);
  $('fileModal').close();
}

async function unassignOpenFile() {
  if (!canEditFiles()) return;
  const id = $('editId').value;
  const file = files.find((item) => item.id === id);
  if (!file) return;
  const patch = {
    prepper: '',
    preppedBy: '',
    preppedById: '',
    qaBy: '',
    qaById: ''
  };
  if (file.status.startsWith('Being prepped by ')) patch.status = 'Ready for Prep';
  if (file.status.startsWith("Being QA'd by ")) patch.status = 'Ready for QA';
  if (!confirm(`Unassign ${file.last}, ${file.first}?`)) return;
  await updateFile(id, patch);
  await addFileLog(id, 'File unassigned', 'Assignment', assignmentSummary(file), 'none');
  $('fileModal').close();
}

function assignmentSummary(file) {
  return [file.prepper && `Specialist: ${file.prepper}`, file.preppedBy && `Prep: ${file.preppedBy}`, file.qaBy && `QA: ${file.qaBy}`].filter(Boolean).join(', ') || 'none';
}

function showBulkModal() {
  $('bulkRows').value = '';
  bulkLinks = [];
  $('bulkMessage').textContent = 'Paste rows to preview them before adding. You can paste more rows before importing.';
  $('bulkPreview').classList.add('hide');
  $('bulkModal').showModal();
}

function safeHttpLink(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function clearBulkLinks() {
  bulkLinks = [];
}

function captureExcelPaste(event) {
  const html = event.clipboardData?.getData('text/html');
  const text = event.clipboardData?.getData('text/plain');
  if (!html || !text) return;
  event.preventDefault();
  const document = new DOMParser().parseFromString(html, 'text/html');
  const pastedLinks = [...document.querySelectorAll('tr')].map((row) => safeHttpLink(row.querySelector('td:first-child a[href],th:first-child a[href]')?.href || ''));
  const textarea = $('bulkRows');
  const existingLines = textarea.value.split(/\r?\n/).filter((line) => line.trim()).length;
  const separator = textarea.value.trim() ? '\n' : '';
  textarea.value = `${textarea.value.trimEnd()}${separator}${text.trim()}`;
  while (bulkLinks.length < existingLines) bulkLinks.push('');
  bulkLinks.push(...pastedLinks);
  previewBulkRows();
}

function parseBulkRows() {
  return $('bulkRows').value.split(/\r?\n/)
    .map((line, index) => ({ sourceLine: index + 1, cells: line.split('\t').map((cell) => cell.trim()), link: bulkLinks[index] || '' }))
    .filter((row) => row.cells.some(Boolean))
    .filter((row, index) => !(index === 0 && ['last name', 'first name', 'device'].some((label) => row.cells.join(' ').toLowerCase().includes(label))))
    .filter((row) => !row.cells[0]?.startsWith('---'))
    .map(({ cells, link }) => ({
      last: cells[0] || '',
      first: cells[1] || '',
      device: cells[2] || '',
      deviceNumber: '',
      gipod: '',
      cameraNumber: '',
      cameraNumber2: '',
      cameraNumber3: '',
      cameraNumber4: '',
      loan: cells[3] || '',
      date: normalizeDate(cells[4]),
      vocab: cells[5] || '',
      notes: cells[6] || '',
      priority: (cells[3] || '').trim().toUpperCase() === 'SL' ? 'EXPEDITE' : 'Normal',
      expires: '',
      lane: '',
      crm: link,
      status: 'Ready for Pre-Prep',
      prepper: ''
    }))
    .filter((row) => row.last && row.first && row.device);
}

function normalizeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString().slice(0, 10);
}

function previewBulkRows() {
  const rows = parseBulkRows();
  const linked = rows.filter((row) => row.crm).length;
  const missingDates = rows.map((row, index) => row.date ? null : index + 1).filter(Boolean);
  $('bulkMessage').className = missingDates.length ? 'error' : rows.length ? 'success' : 'muted';
  $('bulkMessage').textContent = rows.length
    ? `${rows.length} valid file${rows.length === 1 ? '' : 's'} ready to add - ${linked} CRM link${linked === 1 ? '' : 's'} captured.${missingDates.length ? ` Missing queue date on import line${missingDates.length === 1 ? '' : 's'} ${missingDates.join(', ')}.` : ''}`
    : 'No valid rows yet. Last name, first name, and device are required.';
  $('bulkPreview').classList.toggle('hide', !rows.length);
  $('bulkPreview').innerHTML = rows.length ? `<table class="table bulk-table"><thead><tr><th>#</th><th>Last</th><th>First</th><th>Device</th><th>Loan</th><th>Queue date</th><th>Vocabulary</th><th>Notes</th><th>CRM</th></tr></thead><tbody>${rows.map((row, index) => `<tr class="${row.date ? '' : 'invalid-row'}"><td>${index + 1}</td><td><input data-bulk-field="last" data-row="${index}" value="${esc(row.last)}"></td><td><input data-bulk-field="first" data-row="${index}" value="${esc(row.first)}"></td><td><input data-bulk-field="device" data-row="${index}" value="${esc(row.device)}"></td><td><input data-bulk-field="loan" data-row="${index}" value="${esc(row.loan)}"></td><td><input type="date" data-bulk-field="date" data-row="${index}" value="${esc(row.date)}"></td><td><input data-bulk-field="vocab" data-row="${index}" value="${esc(row.vocab)}"></td><td><input data-bulk-field="notes" data-row="${index}" value="${esc(row.notes)}"></td><td>${row.crm ? 'Linked' : 'none'}<input type="hidden" data-bulk-field="crm" data-row="${index}" value="${esc(row.crm)}"></td></tr>`).join('')}</tbody></table>` : '';
  $('bulkSubmit').disabled = Boolean(missingDates.length);
}

function validateEditedBulkRows() {
  const rows = editedBulkRows();
  const missingDates = rows.map((row, index) => row.date ? null : index + 1).filter(Boolean);
  $('bulkPreview').querySelectorAll('tbody tr').forEach((tr, index) => {
    tr.classList.toggle('invalid-row', !rows[index]?.date);
  });
  $('bulkSubmit').disabled = Boolean(missingDates.length);
  if (!rows.length) {
    $('bulkMessage').className = 'muted';
    $('bulkMessage').textContent = 'No valid rows yet. Last name, first name, and device are required.';
    return;
  }
  $('bulkMessage').className = missingDates.length ? 'error' : 'success';
  $('bulkMessage').textContent = missingDates.length
    ? `Missing queue date on import line${missingDates.length === 1 ? '' : 's'} ${missingDates.join(', ')}.`
    : `${rows.length} file${rows.length === 1 ? '' : 's'} ready to add.`;
}

function editedBulkRows() {
  const table = $('bulkPreview').querySelector('tbody');
  if (!table) return [];
  return [...table.querySelectorAll('tr')].map((tr, index) => {
    const value = (field) => tr.querySelector(`[data-bulk-field="${field}"]`)?.value.trim() || '';
    const loan = value('loan');
    return {
      last: value('last'),
      first: value('first'),
      device: value('device'),
      deviceNumber: '',
      gipod: '',
      cameraNumber: '',
      cameraNumber2: '',
      cameraNumber3: '',
      cameraNumber4: '',
      loan,
      date: value('date'),
      vocab: value('vocab'),
      notes: value('notes'),
      priority: loan.trim().toUpperCase() === 'SL' ? 'EXPEDITE' : 'Normal',
      expires: '',
      lane: '',
      crm: value('crm'),
      status: 'Ready for Pre-Prep',
      prepper: ''
    };
  }).filter((row) => row.last && row.first && row.device);
}

async function addBulkFiles(event) {
  event.preventDefault();
  const editedRows = editedBulkRows();
  const rows = editedRows.length ? editedRows : parseBulkRows();
  if (!rows.length) {
    previewBulkRows();
    $('bulkMessage').className = 'error';
    return;
  }
  const missingDates = rows.map((row, index) => row.date ? null : index + 1).filter(Boolean);
  if (missingDates.length) {
    $('bulkMessage').className = 'error';
    $('bulkMessage').textContent = `Missing queue date on import line${missingDates.length === 1 ? '' : 's'} ${missingDates.join(', ')}.`;
    return;
  }
  const { error } = await withSupabaseRetry(() => supabase.from('trial_files').insert(rows.map(fileToRow)));
  if (error) return showError(error);
  $('bulkModal').close();
  view = canView('preprep') ? 'preprep' : firstAllowedView();
  await loadData();
}

function showCodeModal() {
  $('codeRows').value = '';
  $('codeMessage').textContent = 'Paste one code per row.';
  $('codeModal').showModal();
}

function parsedGipodCodes() {
  return $('codeRows').value.split(/\s+/)
    .map((code) => code.trim())
    .filter(Boolean)
    .filter((code, index, list) => list.indexOf(code) === index && !gipodCodes.some((item) => item.code.toLowerCase() === code.toLowerCase()));
}

function previewGipodCodes() {
  const codes = parsedGipodCodes();
  $('codeMessage').textContent = `${codes.length} new code${codes.length === 1 ? '' : 's'} ready to import.`;
}

async function addGipodCodes(event) {
  event.preventDefault();
  const codes = parsedGipodCodes();
  if (!codes.length) return;
  const { error } = await withSupabaseRetry(() => supabase.from('gipod_codes').insert(codes.map((code) => ({ code }))));
  if (error) return showError(error);
  $('codeModal').close();
  await loadData();
}

function showManualGipodModal(id) {
  const item = gipodCodes.find((code) => code.id === id);
  if (!item) return;
  $('useCodeId').value = id;
  $('useCodeTitle').textContent = `Use GIPOD code ${item.code}`;
  $('useCodeCrm').value = /^\d{5}$/.test(item.usedOn) ? item.usedOn : '';
  $('useCodeNote').value = item.note || '';
  $('useCodeModal').showModal();
  $('useCodeCrm').focus();
}

async function saveManualGipodUse(event) {
  event.preventDefault();
  await updateGipod($('useCodeId').value, {
    usedOn: $('useCodeCrm').value.trim(),
    note: $('useCodeNote').value.trim()
  });
  $('useCodeModal').close();
}

async function moveToNextStep(id) {
  const file = files.find((item) => item.id === id);
  const next = file && statusStepFor(file);
  if (!next) return;
  await updateFile(id, { status: next });
  if (file.status.startsWith('Being prepped by ') && next === 'Ready for QA' && file.preppedById) {
    await logActivity(file.preppedById, id, 'prep_completed');
  }
  if (file.status.startsWith("Being QA'd by ") && next === 'Complete' && file.qaById) {
    await logActivity(file.qaById, id, 'qa_completed');
  }
  if (file.status === 'Complete' && next === 'Shipped') {
    await logShipment(file);
  }
}

async function logActivity(userId, fileId, action) {
  const { error } = await withSupabaseRetry(() => supabase.from('app_user_activity').insert({
    user_id: userId,
    file_id: fileId,
    action,
    activity_date: todayLocalDate()
  }));
  if (error) return showError(error);
}

async function logShipment(file) {
  const { error } = await withSupabaseRetry(() => supabase.from('app_shipment_activity').insert({
    file_id: file.id,
    first_name: file.first || '',
    last_name: file.last || '',
    loan_type: file.loan || '',
    device: file.device || '',
    lane: file.lane || '',
    shipped_by_user_id: currentUser?.id || null,
    shipped_date: todayLocalDate()
  }));
  if (error && error.code !== '23505') return showError(error);
}

function addCount(counts, label) {
  const key = label || 'Not listed';
  counts[key] = (counts[key] || 0) + 1;
}

function fileAccessories(file) {
  return String(file.notes || '')
    .split(/\r?\n|,|;|\/|\+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanupPayload(shippedFiles) {
  const loanTotals = {};
  const deviceTotals = {};
  const accessoryTotals = {};
  const cleanupFiles = shippedFiles.map((file) => {
    const accessories = fileAccessories(file);
    addCount(loanTotals, file.loan);
    addCount(deviceTotals, file.device);
    if (accessories.length) accessories.forEach((accessory) => addCount(accessoryTotals, accessory));
    else addCount(accessoryTotals, 'None listed');
    return {
      id: file.id,
      firstName: file.first || '',
      lastName: file.last || '',
      device: file.device || '',
      loan: file.loan || '',
      lane: file.lane || '',
      accessories
    };
  });
  return {
    cleanup_date: todayLocalDate(),
    cleaned_by_user_id: currentUser?.id || null,
    file_count: shippedFiles.length,
    loan_totals: loanTotals,
    device_totals: deviceTotals,
    accessory_totals: accessoryTotals,
    files: cleanupFiles
  };
}

async function endOfDayCleanup() {
  const shippedFiles = stableFileOrder(files).filter((file) => file.status === 'Shipped');
  if (!shippedFiles.length) {
    alert('There are no shipped files to clean up.');
    return;
  }
  if (!confirm(`End of day cleanup will archive and clear ${shippedFiles.length} shipped file${shippedFiles.length === 1 ? '' : 's'} from the shipped lane. Continue?`)) return;
  const { error: insertError } = await withSupabaseRetry(() => supabase.from('app_eod_cleanups').insert(cleanupPayload(shippedFiles)));
  if (insertError) return showError(insertError);
  const { error: deleteError } = await withSupabaseRetry(() => supabase.from('trial_files').delete().in('id', shippedFiles.map((file) => file.id)));
  if (deleteError) return showError(deleteError);
  await loadData();
}

async function claimPrep(id) {
  if (effectiveRole() !== 'Device Coordinator') {
    alert('Only Device Coordinators can claim prep work.');
    return;
  }
  await claimPrepFromNotification(id);
}

async function claimQa(id) {
  if (effectiveRole() !== 'Device Coordinator') {
    alert('Only Device Coordinators can claim QA work.');
    return;
  }
  const file = files.find((item) => item.id === id);
  if (file?.preppedById === currentUser.id) {
    alert('You cannot claim QA for a file you prepped.');
    return;
  }
  const initials = currentUserInitials();
  await updateFile(id, {
    status: `Being QA'd by ${initials}`,
    qaBy: initials,
    qaById: currentUser.id
  });
}

async function deleteFile(id) {
  const file = files.find((item) => item.id === id);
  if (!file || !isPrePrep(file) || !confirm(`Delete ${file.last}, ${file.first}? This cannot be undone.`)) return;
  const { error } = await withSupabaseRetry(() => supabase.from('trial_files').delete().eq('id', id));
  if (error) return showError(error);
  await loadData();
}

async function bulkDeleteFiles() {
  const ids = [...selectedFileIds].filter((id) => files.some((file) => file.id === id && isPrePrep(file)));
  if (!ids.length || !canEditFiles()) return;
  if (!confirm(`Delete ${ids.length} selected file${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  const { error } = await withSupabaseRetry(() => supabase.from('trial_files').delete().in('id', ids));
  if (error) return showError(error);
  selectedFileIds.clear();
  await loadData();
}

async function deleteCleanup(id) {
  if (!canManageUsers()) return;
  const cleanup = eodCleanups.find((item) => item.id === id);
  if (!cleanup || !confirm(`Delete the end-of-day cleanup report for ${formatDate(cleanup.cleanup_date)}? This cannot be undone.`)) return;
  const { error } = await withSupabaseRetry(() => supabase.from('app_eod_cleanups').delete().eq('id', id));
  if (error) return showError(error);
  await loadData();
}

async function deleteLeadReports() {
  if (!canManageUsers()) {
    alert('Only Admin and Lead users can delete lead reports.');
    return;
  }
  const reportCount = shipmentHistory.length + eodCleanups.length;
  if (!reportCount) return;
  if (!confirm(`Delete all Lead Dashboard reports? This will remove ${shipmentHistory.length} shipped file report${shipmentHistory.length === 1 ? '' : 's'} and ${eodCleanups.length} end-of-day cleanup report${eodCleanups.length === 1 ? '' : 's'}. This cannot be undone.`)) return;
  const { error: shipmentError } = await withSupabaseRetry(() => supabase.from('app_shipment_activity').delete().not('id', 'is', null));
  if (shipmentError) return showError(shipmentError);
  const { error: cleanupError } = await withSupabaseRetry(() => supabase.from('app_eod_cleanups').delete().not('id', 'is', null));
  if (cleanupError) return showError(cleanupError);
  shipmentHistory = [];
  eodCleanups = [];
  await loadData();
}

function showError(error) {
  console.error(error);
  if (isRecoverableSupabaseError(error)) {
    scheduleRealtimeReconnect('Connection reconnecting');
    alert(error.message || 'Connection issue. The app is reconnecting.');
    return;
  }
  setConnection('Error', error.message || 'Supabase error');
  alert(error.message || 'Supabase error');
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  if (['open-file', 'next-step', 'ready-for-prep', 'delete-file', 'delete-cleanup', 'delete-lead-reports', 'export-daily-reports', 'link-sidekick-profile', 'select-file', 'assign-lane', 'update-device-number', 'code-filter', 'claim-prep-notification', 'delete-user', 'claim-gipod', 'claim-file', 'claim-prep', 'claim-qa', 'use-code', 'save-code-note', 'file-tab', 'unassign-file'].includes(action)) event.stopPropagation();
  if (action === 'open-file') openFile(id);
  if (action === 'next-step' || action === 'ready-for-prep') await moveToNextStep(id);
  if (action === 'delete-file') await deleteFile(id);
  if (action === 'delete-cleanup') await deleteCleanup(id);
  if (action === 'delete-lead-reports') await deleteLeadReports();
  if (action === 'export-daily-reports') exportDailyReports();
  if (action === 'link-sidekick-profile') await linkSidekickProfile(id);
  if (action === 'claim-prep-notification') await claimPrepFromNotification(id);
  if (action === 'prepper-filter') setPrepperFilter(target.dataset.name);
  if (action === 'code-filter') setCodeTab(target.dataset.name);
  if (action === 'use-code') showManualGipodModal(id);
  if (action === 'claim-gipod') await claimNextGipodCode(id);
  if (action === 'claim-file') await claimFile(id);
  if (action === 'claim-prep') await claimPrep(id);
  if (action === 'claim-qa') await claimQa(id);
  if (action === 'reset-user-pin') await resetUserPin(id);
  if (action === 'delete-user') await deleteUser(id);
  if (action === 'save-code-note') await saveGipodNote(id);
  if (action === 'open-profile') await openProfile(id);
  if (action === 'change-own-pin') await changeOwnPin();
  if (action === 'save-profile-schedule') await saveProfileSchedule(id);
  if (action === 'save-trained-devices') await saveTrainedDevices(id);
  if (action === 'file-tab') setFileTab(target.dataset.name);
  if (action === 'unassign-file') await unassignOpenFile();
  if (action === 'close-dialog') target.closest('dialog')?.close();
});

document.addEventListener('keydown', async (event) => {
  if (event.target.dataset.action !== 'update-device-number' || event.key !== 'Enter') return;
  event.preventDefault();
  event.target.blur();
});

document.addEventListener('focusout', async (event) => {
  if (event.target.dataset.action === 'update-device-number') {
    await saveDeviceNumber(event.target.dataset.id, event.target.value.trim());
  }
});

document.addEventListener('change', async (event) => {
  if (event.target.dataset.action === 'select-file') {
    if (event.target.checked) selectedFileIds.add(event.target.dataset.id);
    else selectedFileIds.delete(event.target.dataset.id);
    renderPrePrep();
  }
  if (event.target.id === 'selectAllFiles') {
    const visibleIds = stableFileOrder(filteredFiles().filter(isPrePrep))
      .filter((file) => prepperFilter === 'All' || file.prepper === prepperFilter)
      .map((file) => file.id);
    visibleIds.forEach((id) => event.target.checked ? selectedFileIds.add(id) : selectedFileIds.delete(id));
    renderPrePrep();
  }
  if (event.target.dataset.action === 'update-user-role') {
    await updateUserRole(event.target.dataset.id, event.target.value);
  }
  if (event.target.dataset.action === 'assign-lane') {
    await updateFile(event.target.dataset.id, { lane: event.target.value });
  }
});

window.addEventListener('pagehide', () => {
  markCurrentUserLoggedIn(false, true);
});

window.addEventListener('beforeunload', () => {
  markCurrentUserLoggedIn(false, true);
});

async function boot() {
  localStorage.removeItem('currentAppUser');
  if (!SUPABASE_URL || !SUPABASE_KEY || SUPABASE_KEY.includes('replace-with')) {
    renderConfig();
    return;
  }
  createSupabaseClient();
  if (!currentUser) {
    renderLogin();
    return;
  }
  await startApp();
}

async function startApp() {
  renderShell();
  try {
    await loadData();
    subscribeRealtime();
    startPresencePolling();
    startHeartbeat();
    startSidekickLogDrain();
  } catch (error) {
    showError(error);
  }
}

boot();
