// ============================================================
// COUNTERPANE INVOICING SYSTEM — app.js
// ============================================================

import { initializeApp, deleteApp }                     from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut,
         onAuthStateChanged, createUserWithEmailAndPassword,
         updatePassword, reauthenticateWithCredential,
         EmailAuthProvider, sendPasswordResetEmail,
         setPersistence, browserSessionPersistence }      from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDocs, getDoc,
         addDoc, setDoc, updateDoc, deleteDoc,
         query, orderBy, where }                         from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── FIREBASE CONFIG ──────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyBenYhpTW4-EdCHStB8WMQS_juW2KZERXs",
  authDomain: "counterpane-invoicing-97ead.firebaseapp.com",
  projectId: "counterpane-invoicing-97ead",
  storageBucket: "counterpane-invoicing-97ead.firebasestorage.app",
  messagingSenderId: "263187889734",
  appId: "1:263187889734:web:333bbd699ec0602f205447",
  measurementId: "G-F69DVPN4SL"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ── STATE ────────────────────────────────────────────────
let currentUser    = null;
let agencySettings = {};
let cache = {
  clients: [], projects: [], invoices: [],
  receipts: [], quotes: [], services: [], templates: []
};

// ── BOOT ─────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Use in-memory persistence so Firebase NEVER auto-logs in from a cached session.
  // Login only happens when the user explicitly clicks "Sign In".
  // The session lives only in RAM — a page refresh always shows the login screen.
  try {
    await setPersistence(auth, browserSessionPersistence);
  } catch (e) { console.warn("setPersistence failed:", e); }

  bindStaticListeners();
  setTopbarDate();

  onAuthStateChanged(auth, async (fbUser) => {
    if (!fbUser) {
      showShell("login");
      // Always reset the login button — covers the sign-out case where the
      // button was left in the "Signing in…" spinner state from a previous session.
      resetLoginBtn();
      document.getElementById("loginError").classList.add("hide");
      return;
    }

    // ── Verify user profile ──────────────────────────────
    let snap;
    try {
      snap = await getDoc(doc(db, "users", fbUser.uid));
    } catch (err) {
      // Firestore unreachable — show error without signing out
      showShell("login");
      showLoginError("Could not reach database: " + err.message);
      resetLoginBtn();
      return;
    }

    if (!snap.exists()) {
      await signOut(auth);
      showShell("login");
      showLoginError("No user profile found. Contact your administrator.");
      resetLoginBtn();
      return;
    }

    currentUser = { uid: fbUser.uid, email: fbUser.email, ...snap.data() };
    await loadSettings();

    // ── Load data — errors here must NOT sign the user out ──
    // A missing Firestore index or missing rules on one collection should not
    // kick the user back to the login screen; they should still reach their dashboard.
    try {
      await bootstrapData();
    } catch (dataErr) {
      // Log it but continue — partial data is better than forced logout
      console.warn("Data bootstrap warning:", dataErr.message);
    }

    // ── Route to correct shell ───────────────────────────
    if (currentUser.role === "admin") {
      populateAdminUI();
      showShell("admin");
    } else if (currentUser.role === "client") {
      populateClientUI();
      showShell("client");
    } else {
      await signOut(auth);
      showShell("login");
      showLoginError("Unknown account role. Contact your administrator.");
      resetLoginBtn();
    }
  });
});

// ── DATA BOOTSTRAP ───────────────────────────────────────
async function bootstrapData() {
  if (currentUser.role === "client") {
    await bootstrapClientData();
  } else {
    await bootstrapAdminData();
  }
}

async function bootstrapAdminData() {
  const [clients, projects, invoices, receipts, quotes, services] = await Promise.all([
    getDocs(query(collection(db, "clients"),  orderBy("companyName"))),
    getDocs(query(collection(db, "projects"), orderBy("projectName"))),
    getDocs(query(collection(db, "invoices"), orderBy("dateIssued", "desc"))),
    getDocs(query(collection(db, "receipts"), orderBy("dateSettled", "desc"))),
    getDocs(query(collection(db, "quotes"),     orderBy("dateCreated", "desc"))),
    getDocs(collection(db, "services")),
    getDocs(collection(db, "invoiceTemplates")),
  ]);
  cache.clients   = clients.docs.map(d   => ({ id: d.id, ...d.data() }));
  cache.projects  = projects.docs.map(d  => ({ id: d.id, ...d.data() }));
  cache.invoices  = invoices.docs.map(d  => ({ id: d.id, ...d.data() }));
  cache.receipts  = receipts.docs.map(d  => ({ id: d.id, ...d.data() }));
  cache.quotes    = quotes.docs.map(d    => ({ id: d.id, ...d.data() }));
  cache.services  = services.docs.map(d  => ({ id: d.id, ...d.data() }));
  cache.templates = templates.docs.map(d => ({ id: d.id, ...d.data() }));
  flagOverdueInvoices();
}

async function bootstrapClientData() {
  // Fetch only this client's data using equality where() filters.
  // No orderBy combined with where() — that would require composite Firestore indexes.
  // We sort client-side instead, which needs zero Firebase Console configuration.
  const cid = currentUser.clientId;

  // Core client data — these must succeed
  const [clientSnap, projects, invoices, receipts, quotes] = await Promise.all([
    getDoc(doc(db, "clients", cid)),
    getDocs(query(collection(db, "projects"), where("clientId", "==", cid))),
    getDocs(query(collection(db, "invoices"), where("clientId", "==", cid))),
    getDocs(query(collection(db, "receipts"), where("clientId", "==", cid))),
    getDocs(query(collection(db, "quotes"),   where("clientId", "==", cid))),
  ]);

  cache.clients  = clientSnap.exists() ? [{ id: clientSnap.id, ...clientSnap.data() }] : [];
  cache.projects = projects.docs.map(d => ({ id: d.id, ...d.data() }));
  // Sort descending by date — avoids composite index requirement entirely
  cache.invoices = invoices.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.dateIssued  || "").localeCompare(a.dateIssued  || ""));
  cache.receipts = receipts.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.dateSettled || "").localeCompare(a.dateSettled || ""));
  cache.quotes   = quotes.docs.map(d   => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.dateCreated || "").localeCompare(a.dateCreated || ""));

  // Services — optional for clients; fetch separately so a missing rule here
  // does NOT crash the whole bootstrap and force the client back to the login screen.
  try {
    const servicesSnap = await getDocs(collection(db, "services"));
    cache.services = servicesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn("Services collection not accessible for client (check Firestore rules). " +
                 "Add: match /services/{id} { allow read: if isSignedIn(); }");
    cache.services = [];
  }

  flagOverdueInvoices();
}

async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "global"));
    agencySettings = snap.exists() ? snap.data() : {};
  } catch { agencySettings = {}; }
}

function flagOverdueInvoices() {
  const today = new Date(); today.setHours(0,0,0,0);
  cache.invoices.forEach(inv => {
    if (inv.status === "UNPAID" && new Date(inv.dueDate) < today) {
      inv.status = "OVERDUE";
      updateDoc(doc(db, "invoices", inv.id), { status: "OVERDUE" }).catch(() => {});
    }
  });
}

// ── SHELL / PAGE ROUTING ─────────────────────────────────
function hideLoader() {
  const loader = document.getElementById("appLoader");
  if (!loader || loader.dataset.removed) return;
  loader.dataset.removed = "1";
  loader.classList.add("fade-out");
  setTimeout(() => { if (loader.parentNode) loader.remove(); }, 300);
}

function showShell(shell) {
  hideLoader();
  const login  = document.getElementById("loginPage");
  const admin  = document.getElementById("adminShell");
  const client = document.getElementById("clientShell");
  login.style.display  = shell === "login"  ? "flex"   : "none";
  admin.classList.toggle("hide",  shell !== "admin");
  client.classList.toggle("hide", shell !== "client");
}

function activateAdminPage(pageId, title) {
  document.querySelectorAll("#adminShell .page").forEach(p => p.classList.remove("active"));
  document.getElementById(pageId)?.classList.add("active");
  document.getElementById("pageTitle").textContent = title || "";
  document.querySelectorAll(".nav-item[data-page]").forEach(n =>
    n.classList.toggle("active", n.dataset.page === pageId));
  renderAdminPage(pageId);
  closeSidebar();
}

function activateClientPage(pageId, title) {
  document.querySelectorAll("#clientShell .page").forEach(p => p.classList.remove("active"));
  document.getElementById(pageId)?.classList.add("active");
  document.getElementById("clientPageTitle").textContent = title || "";
  document.querySelectorAll(".nav-item[data-client-page]").forEach(n =>
    n.classList.toggle("active", n.dataset.clientPage === pageId));
  renderClientPage(pageId);
  closeSidebar();
}

const ADMIN_PAGES = {
  adminDashboardPage: "Dashboard",      clientsPage:    "Clients",
  servicesPage:       "Services",       projectsPage:   "Projects",
  invoicesPage:       "Invoices",       receiptsPage:   "Receipts",
  quotesPage:         "Quotes",         templatesPage:  "Invoice Templates",
  reportsPage:        "Reports",        settingsPage:   "Settings",
};
const CLIENT_PAGES = {
  clientDashboardPage: "Overview",   clientInvoicesPage: "My Invoices",
  clientReceiptsPage:  "My Receipts",clientQuotesPage:   "My Quotes",
  clientProjectsPage:  "My Projects",clientPasswordPage: "Change Password",
};

function renderAdminPage(id) {
  ({
    adminDashboardPage: renderAdminDashboard,
    clientsPage:        renderClientsTable,
    servicesPage:       renderServicesPage,
    projectsPage:       renderProjectsTable,
    invoicesPage:       renderInvoicesTable,
    receiptsPage:       renderReceiptsTable,
    quotesPage:         renderQuotesTable,
    templatesPage:      renderTemplatesPage,
    reportsPage:        renderReports,
    settingsPage:       renderSettings,
  }[id] || (() => {}))();
}

function renderClientPage(id) {
  ({
    clientDashboardPage: renderClientDashboard,
    clientInvoicesPage:  renderClientInvoices,
    clientReceiptsPage:  renderClientReceipts,
    clientQuotesPage:    renderClientQuotes,
    clientProjectsPage:  renderClientProjects,
    clientPasswordPage:  renderClientPassword,
  }[id] || (() => {}))();
}

// ── POPULATE UI ──────────────────────────────────────────
function populateAdminUI() {
  const name = currentUser.email.split("@")[0];
  document.getElementById("adminName").textContent    = name;
  document.getElementById("adminAvatar").textContent  = name[0].toUpperCase();
  document.getElementById("topbarAgency").textContent = agencySettings.agencyName || "Counterpane";
  activateAdminPage("adminDashboardPage", "Dashboard");
}

function populateClientUI() {
  const name = currentUser.email.split("@")[0];
  document.getElementById("clientName").textContent         = name;
  document.getElementById("clientAvatar").textContent       = name[0].toUpperCase();
  document.getElementById("clientTopbarAgency").textContent = agencySettings.agencyName || "Counterpane";
  activateClientPage("clientDashboardPage", "Overview");
}

function setTopbarDate() {
  const el = document.getElementById("topbarDate");
  if (el) el.textContent = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ── HELPERS ──────────────────────────────────────────────
function fmt(amount) {
  const sym = agencySettings.currency || "GHS";
  return `${sym} ${Number(amount || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function clientName(id) {
  return cache.clients.find(c => c.id === id)?.companyName || "—";
}

function statusBadge(status) {
  const cls = {
    PAID: "badge-paid", UNPAID: "badge-unpaid", OVERDUE: "badge-overdue",
    PROPOSED: "badge-proposed", CONVERTED: "badge-converted",
    Active: "badge-active", "On Hold": "badge-hold",
    Completed: "badge-done", Internal: "badge-done",
  };
  return `<span class="badge ${cls[status] || ''}">${status}</span>`;
}

function genNumber(prefix, items) {
  const pad = String(items.length + 1).padStart(4, "0");
  return `${prefix}-${pad}${Date.now().toString().slice(-4)}`;
}

function today() { return new Date().toISOString().split("T")[0]; }

function daysOverdue(d) { return Math.max(0, Math.floor((Date.now() - new Date(d)) / 86400000)); }

function resetLoginBtn() {
  const btn = document.getElementById("loginBtn");
  btn.disabled = false;
  btn.innerHTML = `<span>Sign In</span><i class="fa-solid fa-arrow-right"></i>`;
}

// ── SIDEBAR MOBILE ───────────────────────────────────────
function openSidebar(sidebarId, overlayId) {
  document.getElementById(sidebarId)?.classList.add("open");
  const ov = document.getElementById(overlayId);
  if (ov) { ov.classList.add("show"); }
}

function closeSidebar() {
  document.getElementById("adminSidebar")?.classList.remove("open");
  document.getElementById("clientSidebar")?.classList.remove("open");
  document.getElementById("sidebarOverlay")?.classList.remove("show");
  document.getElementById("clientSidebarOverlay")?.classList.remove("show");
}

// ── TOAST ────────────────────────────────────────────────
function toast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const icons = { success: "circle-check", error: "circle-xmark", warning: "triangle-exclamation" };
  el.innerHTML = `<i class="fa-solid fa-${icons[type] || 'circle-check'}"></i> ${msg}`;
  document.getElementById("toastContainer").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function showLoginError(msg) {
  const el = document.getElementById("loginError");
  el.textContent = msg; el.classList.remove("hide");
}

// ── MODAL HELPERS ────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.remove("hide"); }
function closeModal(id) { document.getElementById(id).classList.add("hide"); }

function confirmAction(msg, onOk) {
  document.getElementById("confirmMsg").textContent = msg;
  openModal("confirmModal");
  const old = document.getElementById("confirmOkBtn");
  const btn = old.cloneNode(true);
  old.replaceWith(btn);
  btn.addEventListener("click", () => { closeModal("confirmModal"); onOk(); }, { once: true });
}

// ── SELECT HELPERS ───────────────────────────────────────
function populateSelect(id, items, labelField, currentVal = "") {
  const sel = document.getElementById(id);
  sel.innerHTML = `<option value="">— Select —</option>` +
    items.map(i => `<option value="${i.id}" ${i.id === currentVal ? "selected" : ""}>${i[labelField]}</option>`).join("");
}

function populateSelectCustom(id, items, labelFn, valueFn) {
  document.getElementById(id).innerHTML = `<option value="">— Select —</option>` +
    items.map(i => `<option value="${valueFn(i)}">${labelFn(i)}</option>`).join("");
}

// ── DELIVERABLES ENGINE ──────────────────────────────────
function initDeliverables(containerId) {
  document.getElementById(containerId).innerHTML = "";
  addDeliverableRow(containerId);
}

function addDeliverableRow(containerId, value = "") {
  const container = document.getElementById(containerId);
  const row = document.createElement("div");
  row.className = "deliverable-row";
  row.innerHTML = `
    <input type="text" class="deliv-input" placeholder="e.g. Responsive 5-page website" value="${value.replace(/"/g, '&quot;')}" />
    <button type="button" class="remove-deliverable-btn"><i class="fa-solid fa-xmark"></i></button>
  `;
  container.appendChild(row);
  row.querySelector(".remove-deliverable-btn").addEventListener("click", () => row.remove());
}

function collectDeliverables(containerId) {
  return [...document.getElementById(containerId).querySelectorAll(".deliv-input")]
    .map(i => i.value.trim()).filter(Boolean);
}

function populateDeliverables(containerId, items) {
  document.getElementById(containerId).innerHTML = "";
  if (items && items.length) {
    items.forEach(v => addDeliverableRow(containerId, v));
  } else {
    addDeliverableRow(containerId);
  }
}

// ── LINE ITEMS ENGINE ────────────────────────────────────
function initLineItems(containerId, calcFn) {
  document.getElementById(containerId).innerHTML = "";
  addLineItemRow(containerId, calcFn);
}

function addLineItemRow(containerId, calcFn) {
  const container = document.getElementById(containerId);
  const row = document.createElement("div");
  row.className = "line-item-row";
  row.innerHTML = `
    <input type="text"   class="li-desc" placeholder="Description" />
    <input type="number" class="li-qty"  value="1"  min="0" step="any" />
    <input type="number" class="li-rate" value="0"  min="0" step="any" />
    <span class="total-cell li-total">0.00</span>
    <button type="button" class="remove-line-btn"><i class="fa-solid fa-xmark"></i></button>
  `;
  container.appendChild(row);
  row.querySelector(".remove-line-btn").addEventListener("click", () => { row.remove(); calcFn(); });
  row.querySelectorAll("input").forEach(inp => inp.addEventListener("input", () => {
    const qty  = parseFloat(row.querySelector(".li-qty").value)  || 0;
    const rate = parseFloat(row.querySelector(".li-rate").value) || 0;
    row.querySelector(".li-total").textContent = (qty * rate).toFixed(2);
    calcFn();
  }));
}

function collectLineItems(containerId) {
  return [...document.getElementById(containerId).querySelectorAll(".line-item-row")]
    .map(row => ({
      description: row.querySelector(".li-desc").value,
      quantity:    parseFloat(row.querySelector(".li-qty").value)  || 0,
      unitRate:    parseFloat(row.querySelector(".li-rate").value) || 0,
      total:       parseFloat(row.querySelector(".li-total").textContent) || 0,
    })).filter(r => r.description.trim() || r.total > 0);
}

function populateLineItems(containerId, items, calcFn) {
  document.getElementById(containerId).innerHTML = "";
  items.forEach(item => {
    addLineItemRow(containerId, calcFn);
    const rows = document.getElementById(containerId).querySelectorAll(".line-item-row");
    const row  = rows[rows.length - 1];
    row.querySelector(".li-desc").value  = item.description;
    row.querySelector(".li-qty").value   = item.quantity;
    row.querySelector(".li-rate").value  = item.unitRate;
    row.querySelector(".li-total").textContent = item.total.toFixed(2);
  });
}

function calcInvoiceTotals() {
  const items   = collectLineItems("invoiceLineItems");
  const sub     = items.reduce((a, i) => a + i.total, 0);
  const discPct = parseFloat(document.getElementById("invoiceDiscount").value) || 0;
  const taxPct  = parseFloat(document.getElementById("invoiceTaxRate").value)  || 0;
  const disc    = sub * (discPct / 100);
  const tax     = (sub - disc) * (taxPct / 100);
  document.getElementById("invSubtotal").textContent    = fmt(sub);
  document.getElementById("invDiscountAmt").textContent = `-${fmt(disc)}`;
  document.getElementById("invTaxAmt").textContent      = fmt(tax);
  document.getElementById("invGrandTotal").textContent  = fmt(sub - disc + tax);
}

function calcQuoteTotals() {
  const items  = collectLineItems("quoteLineItems");
  const sub    = items.reduce((a, i) => a + i.total, 0);
  const taxPct = parseFloat(document.getElementById("quoteTaxRate").value) || 0;
  const tax    = sub * (taxPct / 100);
  document.getElementById("quoteSubtotal").textContent   = fmt(sub);
  document.getElementById("quoteTaxAmt").textContent     = fmt(tax);
  document.getElementById("quoteGrandTotal").textContent = fmt(sub + tax);
}

// ── STATIC LISTENERS ─────────────────────────────────────
function bindStaticListeners() {

  // LOGIN
  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    document.getElementById("loginError").classList.add("hide");
    const btn = document.getElementById("loginBtn");
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Signing in…`;
    try {
      await signInWithEmailAndPassword(auth,
        document.getElementById("loginEmail").value.trim(),
        document.getElementById("loginPassword").value);
    } catch (err) {
      resetLoginBtn();
      const msgs = {
        "auth/user-not-found":     "No account with this email.",
        "auth/wrong-password":     "Incorrect password.",
        "auth/invalid-credential": "Invalid email or password.",
        "auth/too-many-requests":  "Too many attempts. Try again later.",
        "auth/invalid-email":      "Enter a valid email address.",
      };
      showLoginError(msgs[err.code] || err.message);
    }
  });

  document.getElementById("togglePw").addEventListener("click", () => {
    const inp = document.getElementById("loginPassword");
    const ico = document.querySelector("#togglePw i");
    inp.type = inp.type === "password" ? "text" : "password";
    ico.className = inp.type === "password" ? "fa-solid fa-eye" : "fa-solid fa-eye-slash";
  });

  document.getElementById("toggleClientPw").addEventListener("click", () => {
    const inp = document.getElementById("clientLoginPassword");
    const ico = document.querySelector("#toggleClientPw i");
    inp.type = inp.type === "password" ? "text" : "password";
    ico.className = inp.type === "password" ? "fa-solid fa-eye" : "fa-solid fa-eye-slash";
  });

  // LOGOUT
  document.getElementById("adminLogoutBtn").addEventListener("click",  () => signOut(auth));
  document.getElementById("clientLogoutBtn").addEventListener("click", () => signOut(auth));

  // MOBILE SIDEBAR
  document.getElementById("hamburgerBtn").addEventListener("click",       () => openSidebar("adminSidebar",  "sidebarOverlay"));
  document.getElementById("clientHamburgerBtn").addEventListener("click", () => openSidebar("clientSidebar", "clientSidebarOverlay"));
  document.getElementById("sidebarCloseBtn").addEventListener("click",       closeSidebar);
  document.getElementById("clientSidebarCloseBtn").addEventListener("click", closeSidebar);
  document.getElementById("sidebarOverlay").addEventListener("click",       closeSidebar);
  document.getElementById("clientSidebarOverlay").addEventListener("click", closeSidebar);

  // SIDEBAR NAV
  document.querySelectorAll(".nav-item[data-page]").forEach(link =>
    link.addEventListener("click", (e) => { e.preventDefault(); const p = link.dataset.page; activateAdminPage(p, ADMIN_PAGES[p]); })
  );
  document.querySelectorAll(".nav-item[data-client-page]").forEach(link =>
    link.addEventListener("click", (e) => { e.preventDefault(); const p = link.dataset.clientPage; activateClientPage(p, CLIENT_PAGES[p]); })
  );
  document.querySelectorAll("a[data-page]").forEach(el =>
    el.addEventListener("click", (e) => { e.preventDefault(); const p = el.dataset.page; if (ADMIN_PAGES[p]) activateAdminPage(p, ADMIN_PAGES[p]); })
  );

  // MODAL CLOSE
  document.querySelectorAll("[data-close]").forEach(btn => btn.addEventListener("click", () => closeModal(btn.dataset.close)));
  document.querySelectorAll(".modal-overlay").forEach(ov => ov.addEventListener("click", (e) => { if (e.target === ov) closeModal(ov.id); }));
  document.getElementById("confirmCancelBtn").addEventListener("click", () => closeModal("confirmModal"));

  // CLIENTS (merged create + account)
  document.getElementById("openAddClientBtn").addEventListener("click", () => {
    document.getElementById("clientEditId").value = "";
    document.getElementById("clientExistingEmail").value = "";
    document.getElementById("clientModalTitle").textContent = "Add Client";
    document.getElementById("clientForm").reset();
    document.getElementById("clientActive").checked = true;
    document.getElementById("clientPortalSection").classList.remove("hide");
    document.getElementById("clientPortalEditSection").classList.add("hide");
    document.getElementById("clientFormError").classList.add("hide");
    document.getElementById("clientSubmitBtn").textContent = "Create Client";
    openModal("clientModal");
  });
  document.getElementById("clientForm").addEventListener("submit", saveClient);
  document.getElementById("clientSearch").addEventListener("input", renderClientsTable);

  // Send password reset from edit modal
  document.getElementById("sendResetEmailBtn").addEventListener("click", async () => {
    const email = document.getElementById("clientExistingEmail").value;
    if (!email) return;
    try {
      await sendPasswordResetEmail(auth, email);
      toast("Password reset email sent to " + email);
    } catch (err) { toast("Failed to send reset email: " + err.message, "error"); }
  });

  // SERVICES
  document.getElementById("openAddServiceCatBtn").addEventListener("click", () => {
    document.getElementById("serviceCatEditId").value = "";
    document.getElementById("serviceCatModalTitle").textContent = "Add Service Category";
    document.getElementById("serviceCategoryForm").reset();
    openModal("serviceCategoryModal");
  });
  document.getElementById("serviceCategoryForm").addEventListener("submit", saveServiceCategory);
  document.getElementById("serviceTypeForm").addEventListener("submit", saveServiceType);
  document.getElementById("addServiceDeliverableBtn").addEventListener("click", () => addDeliverableRow("serviceTypeDeliverablesContainer"));

  // PROJECTS
  document.getElementById("openAddProjectBtn").addEventListener("click", () => openProjectModal());
  document.getElementById("projectForm").addEventListener("submit", saveProject);
  document.getElementById("projectSearch").addEventListener("input", renderProjectsTable);
  document.getElementById("addProjectDeliverableBtn").addEventListener("click", () => addDeliverableRow("projectDeliverablesList"));
  document.getElementById("projectServiceCategory").addEventListener("change", onServiceCategoryChange);
  document.getElementById("projectServiceType").addEventListener("change", onServiceTypeChange);

  // INVOICES
  document.getElementById("openAddInvoiceBtn").addEventListener("click", () => {
    document.getElementById("invoiceEditId").value = "";
    document.getElementById("invoiceModalTitle").textContent = "New Invoice";
    document.getElementById("invoiceForm").reset();
    document.getElementById("invoiceDate").value = today();
    populateSelect("invoiceClientTarget", cache.clients, "companyName");
    // Reset project dropdown
    document.getElementById("invoiceProjectTarget").innerHTML = '<option value="">— None / Select Project —</option>';
    initLineItems("invoiceLineItems", calcInvoiceTotals);
    calcInvoiceTotals();
    openModal("invoiceModal");
  });

  // When client changes on invoice form, populate project dropdown
  document.getElementById("invoiceClientTarget").addEventListener("change", () => {
    const cid = document.getElementById("invoiceClientTarget").value;
    const projects = cache.projects.filter(p => p.clientId === cid);
    const sel = document.getElementById("invoiceProjectTarget");
    sel.innerHTML = '<option value="">— None / Select Project —</option>' +
      projects.map(p => `<option value="${p.id}">${p.projectName}${p.serviceTypeName ? ' · ' + p.serviceTypeName : ''}</option>`).join('');
  });
  document.getElementById("addInvoiceLineBtn").addEventListener("click", () => addLineItemRow("invoiceLineItems", calcInvoiceTotals));
  document.getElementById("invoiceTaxRate").addEventListener("input", calcInvoiceTotals);
  document.getElementById("invoiceDiscount").addEventListener("input", calcInvoiceTotals);
  document.getElementById("invoiceForm").addEventListener("submit", saveInvoice);
  document.getElementById("invoiceSearch").addEventListener("input", renderInvoicesTable);
  document.getElementById("invoiceStatusFilter").addEventListener("change", renderInvoicesTable);

  // RECEIPTS
  document.getElementById("openAddReceiptBtn").addEventListener("click", () => {
    document.getElementById("receiptForm").reset();
    document.getElementById("receiptDate").value = today();
    document.getElementById("receiptAmountHint").textContent = "";
    const unpaid = cache.invoices.filter(i => i.status === "UNPAID" || i.status === "OVERDUE");
    populateSelectCustom("receiptInvoiceTarget", unpaid,
      inv => `${inv.invoiceNumber} — ${clientName(inv.clientId)} (${fmt(inv.grossTotal)})`,
      inv => inv.id);
    openModal("receiptModal");
  });

  // Auto-fill amount when invoice is selected
  document.getElementById("receiptInvoiceTarget").addEventListener("change", () => {
    const invId = document.getElementById("receiptInvoiceTarget").value;
    const inv   = cache.invoices.find(i => i.id === invId);
    const hint  = document.getElementById("receiptAmountHint");
    if (inv) {
      document.getElementById("receiptAmount").value = inv.grossTotal?.toFixed(2) || "";
      hint.textContent = ` — Invoice total: ${fmt(inv.grossTotal)}`;
    } else {
      document.getElementById("receiptAmount").value = "";
      hint.textContent = "";
    }
  });
  document.getElementById("receiptForm").addEventListener("submit", saveReceipt);
  document.getElementById("receiptSearch").addEventListener("input", renderReceiptsTable);

  // QUOTES
  document.getElementById("openAddQuoteBtn").addEventListener("click", () => {
    document.getElementById("quoteForm").reset();
    document.getElementById("quoteDate").value = today();
    populateSelect("quoteClientTarget", cache.clients, "companyName");
    initLineItems("quoteLineItems", calcQuoteTotals);
    calcQuoteTotals();
    openModal("quoteModal");
  });
  document.getElementById("addQuoteLineBtn").addEventListener("click", () => addLineItemRow("quoteLineItems", calcQuoteTotals));
  document.getElementById("quoteTaxRate").addEventListener("input", calcQuoteTotals);
  document.getElementById("quoteForm").addEventListener("submit", saveQuote);
  document.getElementById("quoteSearch").addEventListener("input", renderQuotesTable);

  // SETTINGS
  document.getElementById("settingsForm").addEventListener("submit", saveSettings);

  // TEMPLATES
  document.getElementById("openAddTemplateBtn").addEventListener("click", () => openTemplateModal());
  document.getElementById("templateForm").addEventListener("submit", saveTemplate);
  document.getElementById("addTemplateLineBtn").addEventListener("click", () => addLineItemRow("templateLineItems", calcTemplateTotals));
  document.getElementById("templateTaxRate").addEventListener("input", calcTemplateTotals);

  // STATEMENT
  document.getElementById("statementForm").addEventListener("submit", generateStatement);

  // PROJECT PROGRESS
  document.getElementById("addMilestoneBtn").addEventListener("click",   () => addMilestoneRow());
  document.getElementById("progressForm").addEventListener("submit",     saveProgress);


  // CLIENT CHANGE PASSWORD
  document.getElementById("changePasswordForm").addEventListener("submit", saveClientPassword);
}

// ═══════════════════════════════════════════════════════════
// ADMIN DASHBOARD
// ═══════════════════════════════════════════════════════════
function renderAdminDashboard() {
  let revenue = 0, unpaid = 0, overdue = 0;
  cache.invoices.forEach(i => {
    if (i.status === "PAID")                              revenue += i.grossTotal || 0;
    if (i.status === "UNPAID" || i.status === "OVERDUE") unpaid  += i.grossTotal || 0;
    if (i.status === "OVERDUE")                           overdue += i.grossTotal || 0;
  });
  const openQuotes = cache.quotes.filter(q => q.status === "PROPOSED").length;
  document.getElementById("statTotalRevenue").textContent    = fmt(revenue);
  document.getElementById("statTotalInvoices").textContent   = cache.invoices.length;
  document.getElementById("statUnpaidInvoices").textContent  = fmt(unpaid);
  document.getElementById("statOverdueInvoices").textContent = fmt(overdue);
  document.getElementById("statTotalClients").textContent    = cache.clients.filter(c => c.isActive).length;
  document.getElementById("statOpenQuotes").textContent      = openQuotes;

  document.getElementById("dashRecentInvoices").innerHTML =
    cache.invoices.slice(0,5).map(inv => `<tr>
      <td class="mono"><strong>${inv.invoiceNumber}</strong></td>
      <td>${clientName(inv.clientId)}</td>
      <td class="mono">${fmt(inv.grossTotal)}</td>
      <td>${statusBadge(inv.status)}</td>
    </tr>`).join("") || `<tr><td colspan="4" class="empty-row">No invoices yet</td></tr>`;

  document.getElementById("dashRecentReceipts").innerHTML =
    cache.receipts.slice(0,5).map(r => `<tr>
      <td class="mono"><strong>${r.receiptNumber}</strong></td>
      <td>${clientName(r.clientId)}</td>
      <td class="mono">${fmt(r.amountPaid)}</td>
      <td>${r.dateSettled || "—"}</td>
    </tr>`).join("") || `<tr><td colspan="4" class="empty-row">No receipts yet</td></tr>`;
}

// ═══════════════════════════════════════════════════════════
// CLIENTS  (merged with account creation)
// ═══════════════════════════════════════════════════════════
function renderClientsTable() {
  const q = (document.getElementById("clientSearch")?.value || "").toLowerCase();
  const rows = cache.clients.filter(c =>
    !q || c.companyName?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q));
  document.getElementById("clientsTableBody").innerHTML = rows.length ? rows.map(c => `<tr>
    <td><strong>${c.companyName}</strong></td>
    <td>${c.contactPerson || "—"}</td>
    <td>${c.email || "—"}</td>
    <td>${c.phone || "—"}</td>
    <td>${statusBadge(c.isActive ? "Active" : "On Hold")}</td>
    <td><div class="row-actions">
      <button class="btn-icon" title="Statement" data-statement-client="${c.id}"><i class="fa-solid fa-file-lines"></i></button>
      <button class="btn-icon" title="Edit" data-edit-client="${c.id}"><i class="fa-solid fa-pen"></i></button>
      <button class="btn-icon danger" title="Delete" data-del-client="${c.id}"><i class="fa-solid fa-trash"></i></button>
    </div></td>
  </tr>`).join("") : `<tr><td colspan="6" class="empty-row">No clients found</td></tr>`;

  document.querySelectorAll("[data-statement-client]").forEach(b => b.addEventListener("click", () => openStatementModal(b.dataset.statementClient)));
  document.querySelectorAll("[data-edit-client]").forEach(b => b.addEventListener("click", () => editClient(b.dataset.editClient)));
  document.querySelectorAll("[data-del-client]").forEach(b => b.addEventListener("click", () =>
    confirmAction(
      "Delete this client? All their invoices, receipts, quotes, projects and portal access will be permanently removed.",
      () => deleteClientCascade(b.dataset.delClient)
    )));
}

async function saveClient(e) {
  e.preventDefault();
  const errEl  = document.getElementById("clientFormError");
  const btn    = document.getElementById("clientSubmitBtn");
  const editId = document.getElementById("clientEditId").value;
  errEl.classList.add("hide");
  btn.disabled = true;
  btn.textContent = editId ? "Saving…" : "Creating…";

  const clientData = {
    companyName:   document.getElementById("clientCompany").value.trim(),
    contactPerson: document.getElementById("clientContact").value.trim(),
    email:         document.getElementById("clientEmail").value.trim(),
    phone:         document.getElementById("clientPhone").value.trim(),
    address:       document.getElementById("clientAddress").value.trim(),
    driveLink:     document.getElementById("clientDrive").value.trim(),
    isActive:      document.getElementById("clientActive").checked,
  };

  try {
    if (editId) {
      // EDIT: just update client record
      await updateDoc(doc(db, "clients", editId), clientData);
      const i = cache.clients.findIndex(c => c.id === editId);
      if (i > -1) cache.clients[i] = { id: editId, ...cache.clients[i], ...clientData };
      closeModal("clientModal");
      renderClientsTable();
      toast("Client updated");
    } else {
      // NEW: create Firebase Auth account first, then client + user docs
      const loginEmail = document.getElementById("clientLoginEmail").value.trim();
      const loginPw    = document.getElementById("clientLoginPassword").value;
      if (!loginEmail) { throw { message: "Portal login email is required." }; }
      if (!loginPw || loginPw.length < 6) { throw { message: "Password must be at least 6 characters." }; }

      // Secondary app so admin stays signed in
      const secondaryApp  = initializeApp(firebaseConfig, `client_${Date.now()}`);
      const secondaryAuth = getAuth(secondaryApp);
      const cred          = await createUserWithEmailAndPassword(secondaryAuth, loginEmail, loginPw);
      const newUid        = cred.user.uid;
      await signOut(secondaryAuth);
      await deleteApp(secondaryApp);

      // Save client document
      const clientRef = await addDoc(collection(db, "clients"), clientData);
      cache.clients.push({ id: clientRef.id, ...clientData });
      cache.clients.sort((a, b) => a.companyName.localeCompare(b.companyName));

      // Save user document — ID must match Firebase Auth UID
      const userDoc = { email: loginEmail, role: "client", clientId: clientRef.id, createdAt: today() };
      await setDoc(doc(db, "users", newUid), userDoc);

      closeModal("clientModal");
      renderClientsTable();
      toast("Client and portal account created");
    }
  } catch (err) {
    const msgs = {
      "auth/email-already-in-use": "This login email already has an account.",
      "auth/invalid-email":        "Invalid login email address.",
      "auth/weak-password":        "Password must be at least 6 characters.",
    };
    errEl.textContent = msgs[err.code] || err.message;
    errEl.classList.remove("hide");
  } finally {
    btn.disabled = false;
    btn.textContent = editId ? "Save Changes" : "Create Client";
  }
}

async function editClient(id) {
  const c = cache.clients.find(c => c.id === id); if (!c) return;
  document.getElementById("clientEditId").value = id;
  document.getElementById("clientModalTitle").textContent = "Edit Client";
  document.getElementById("clientCompany").value  = c.companyName   || "";
  document.getElementById("clientContact").value  = c.contactPerson || "";
  document.getElementById("clientEmail").value    = c.email         || "";
  document.getElementById("clientPhone").value    = c.phone         || "";
  document.getElementById("clientAddress").value  = c.address       || "";
  document.getElementById("clientDrive").value    = c.driveLink     || "";
  document.getElementById("clientActive").checked = c.isActive !== false;

  // Hide account creation, show account info
  document.getElementById("clientPortalSection").classList.add("hide");
  document.getElementById("clientPortalEditSection").classList.remove("hide");
  document.getElementById("clientFormError").classList.add("hide");
  document.getElementById("clientSubmitBtn").textContent = "Save Changes";

  // Find linked user to show their login email
  try {
    const usersSnap = await getDocs(collection(db, "users"));
    const userDoc = usersSnap.docs.find(d => d.data().clientId === id && d.data().role === "client");
    const portalEmail = userDoc ? userDoc.data().email : "No portal account";
    document.getElementById("clientPortalEmailDisplay").textContent = portalEmail;
    document.getElementById("clientExistingEmail").value = portalEmail;
  } catch {
    document.getElementById("clientPortalEmailDisplay").textContent = "—";
  }

  openModal("clientModal");
}

// ── CASCADE DELETE CLIENT ────────────────────────────────
async function deleteClientCascade(clientId) {
  try {
    // 1. Fetch all related documents in parallel
    const [invoicesSnap, quotesSnap, receiptsSnap, projectsSnap, usersSnap] = await Promise.all([
      getDocs(query(collection(db, "invoices"),  where("clientId", "==", clientId))),
      getDocs(query(collection(db, "quotes"),    where("clientId", "==", clientId))),
      getDocs(query(collection(db, "receipts"),  where("clientId", "==", clientId))),
      getDocs(query(collection(db, "projects"),  where("clientId", "==", clientId))),
      getDocs(query(collection(db, "users"),     where("clientId", "==", clientId))),
    ]);

    // 2. Count what will be deleted for the summary message
    const counts = {
      invoices:  invoicesSnap.size,
      quotes:    quotesSnap.size,
      receipts:  receiptsSnap.size,
      projects:  projectsSnap.size,
      users:     usersSnap.size,
    };

    // 3. Delete everything in Firestore
    const deletes = [
      deleteDoc(doc(db, "clients", clientId)),
      ...invoicesSnap.docs.map(d  => deleteDoc(d.ref)),
      ...quotesSnap.docs.map(d    => deleteDoc(d.ref)),
      ...receiptsSnap.docs.map(d  => deleteDoc(d.ref)),
      ...projectsSnap.docs.map(d  => deleteDoc(d.ref)),
      ...usersSnap.docs.map(d     => deleteDoc(d.ref)),
    ];
    await Promise.all(deletes);

    // 4. Update in-memory cache
    cache.clients  = cache.clients.filter(c  => c.id       !== clientId);
    cache.invoices = cache.invoices.filter(i => i.clientId !== clientId);
    cache.quotes   = cache.quotes.filter(q   => q.clientId !== clientId);
    cache.receipts = cache.receipts.filter(r => r.clientId !== clientId);
    cache.projects = cache.projects.filter(p => p.clientId !== clientId);

    renderClientsTable();
    renderAdminDashboard();

    // 5. Inform admin about what was removed and the Auth account
    const summary = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");

    // The Firebase Auth account becomes inaccessible immediately (no Firestore profile =
    // login fails). On the free Spark plan, Auth accounts cannot be deleted programmatically
    // without Cloud Functions. Remove it manually: Firebase Console → Authentication → Users.
    const authNote = counts.users > 0
      ? "\n\n⚠️ Portal login blocked. To fully remove the Firebase Auth entry go to:\nFirebase Console → Authentication → Users → delete the account manually."
      : "";

    toast(`Client deleted${summary ? ` (removed: ${summary})` : ""}.`, "success");
    if (counts.users > 0) {
      setTimeout(() => {
        toast("Remove the Auth account in Firebase Console → Authentication → Users.", "warning");
      }, 800);
    }

  } catch (err) {
    toast("Error during cascade delete: " + err.message, "error");
  }
}

// ═══════════════════════════════════════════════════════════
// SERVICES
// ═══════════════════════════════════════════════════════════
function renderServicesPage() {
  const list = document.getElementById("servicesCategoriesList");
  if (!cache.services.length) {
    list.innerHTML = `<div class="empty-row" style="padding:40px;text-align:center;color:var(--text-3)">
      <i class="fa-solid fa-briefcase" style="font-size:28px;margin-bottom:10px;display:block"></i>
      No service categories yet. Click "Add Service Category" to get started.
    </div>`;
    return;
  }
  list.innerHTML = cache.services.map(svc => `
    <div class="service-category-card" id="svcCard_${svc.id}">
      <div class="service-cat-header" data-toggle-svc="${svc.id}">
        <div class="service-cat-icon"><i class="fa-solid fa-briefcase"></i></div>
        <div class="service-cat-info">
          <div class="service-cat-name">${svc.categoryName}</div>
          ${svc.description ? `<div class="service-cat-desc">${svc.description}</div>` : ""}
        </div>
        <div class="service-cat-actions" onclick="event.stopPropagation()">
          <button class="btn-icon" title="Edit category" data-edit-svc="${svc.id}"><i class="fa-solid fa-pen"></i></button>
          <button class="btn-icon danger" title="Delete category" data-del-svc="${svc.id}"><i class="fa-solid fa-trash"></i></button>
        </div>
        <i class="fa-solid fa-chevron-right service-cat-chevron" id="chevron_${svc.id}"></i>
      </div>
      <div class="service-cat-body" id="svcBody_${svc.id}">
        <div class="service-types-list">
          ${(svc.types || []).map(t => `
            <div class="service-type-row" id="typeRow_${svc.id}_${t.id}">
              <div class="service-type-info">
                <div class="service-type-name">${t.typeName}</div>
                ${t.description ? `<div class="service-type-desc">${t.description}</div>` : ""}
                <div class="service-type-price">${fmt(t.basePrice || 0)}</div>
                <div class="service-type-deliverables">
                  ${(t.deliverables || []).map(d => `
                    <div class="service-type-deliverable"><i class="fa-solid fa-check"></i>${d}</div>
                  `).join("")}
                </div>
              </div>
              <div class="service-type-actions">
                <button class="btn-icon" title="Edit plan" data-edit-type="${svc.id}" data-type-id="${t.id}"><i class="fa-solid fa-pen"></i></button>
                <button class="btn-icon danger" title="Delete plan" data-del-type="${svc.id}" data-type-id="${t.id}"><i class="fa-solid fa-trash"></i></button>
              </div>
            </div>`).join("")}
        </div>
        <button class="btn-ghost btn-sm add-plan-btn" data-add-plan="${svc.id}"><i class="fa-solid fa-plus"></i> Add Plan</button>
      </div>
    </div>
  `).join("");

  // Toggle expand/collapse
  document.querySelectorAll("[data-toggle-svc]").forEach(header =>
    header.addEventListener("click", () => {
      const id    = header.dataset.toggleSvc;
      const body  = document.getElementById(`svcBody_${id}`);
      const chev  = document.getElementById(`chevron_${id}`);
      body.classList.toggle("open");
      chev.classList.toggle("open");
    })
  );

  // Edit category
  document.querySelectorAll("[data-edit-svc]").forEach(b => b.addEventListener("click", () => editServiceCategory(b.dataset.editSvc)));

  // Delete category
  document.querySelectorAll("[data-del-svc]").forEach(b => b.addEventListener("click", () =>
    confirmAction("Delete this service category and all its plans?", () => deleteServiceCategory(b.dataset.delSvc))));

  // Add plan
  document.querySelectorAll("[data-add-plan]").forEach(b => b.addEventListener("click", () => openServiceTypeModal(b.dataset.addPlan, null)));

  // Edit plan
  document.querySelectorAll("[data-edit-type]").forEach(b => b.addEventListener("click", () => openServiceTypeModal(b.dataset.editType, b.dataset.typeId)));

  // Delete plan
  document.querySelectorAll("[data-del-type]").forEach(b => b.addEventListener("click", () =>
    confirmAction("Delete this plan?", () => deleteServiceType(b.dataset.delType, b.dataset.typeId))));
}

async function saveServiceCategory(e) {
  e.preventDefault();
  const editId = document.getElementById("serviceCatEditId").value;
  const data = {
    categoryName: document.getElementById("serviceCatName").value.trim(),
    description:  document.getElementById("serviceCatDesc").value.trim(),
  };
  try {
    if (editId) {
      await updateDoc(doc(db, "services", editId), data);
      const i = cache.services.findIndex(s => s.id === editId);
      if (i > -1) Object.assign(cache.services[i], data);
    } else {
      data.types = [];
      const ref = await addDoc(collection(db, "services"), data);
      cache.services.push({ id: ref.id, ...data });
    }
    closeModal("serviceCategoryModal");
    renderServicesPage();
    toast(editId ? "Category updated" : "Category added");
  } catch (err) { toast("Error: " + err.message, "error"); }
}

function editServiceCategory(id) {
  const svc = cache.services.find(s => s.id === id); if (!svc) return;
  document.getElementById("serviceCatEditId").value = id;
  document.getElementById("serviceCatModalTitle").textContent = "Edit Category";
  document.getElementById("serviceCatName").value  = svc.categoryName || "";
  document.getElementById("serviceCatDesc").value  = svc.description  || "";
  openModal("serviceCategoryModal");
}

async function deleteServiceCategory(id) {
  try {
    await deleteDoc(doc(db, "services", id));
    cache.services = cache.services.filter(s => s.id !== id);
    renderServicesPage();
    toast("Category deleted");
  } catch (err) { toast("Error: " + err.message, "error"); }
}

function openServiceTypeModal(catId, typeId) {
  document.getElementById("serviceTypeCatId").value  = catId;
  document.getElementById("serviceTypeEditId").value = typeId || "";
  const svc = cache.services.find(s => s.id === catId);

  if (typeId) {
    const type = (svc?.types || []).find(t => t.id === typeId);
    if (!type) return;
    document.getElementById("serviceTypeModalTitle").textContent = "Edit Plan";
    document.getElementById("serviceTypeName").value  = type.typeName    || "";
    document.getElementById("serviceTypePrice").value = type.basePrice   || "";
    document.getElementById("serviceTypeDesc").value  = type.description || "";
    populateDeliverables("serviceTypeDeliverablesContainer", type.deliverables || []);
  } else {
    document.getElementById("serviceTypeModalTitle").textContent = "Add Plan";
    document.getElementById("serviceTypeForm").reset();
    document.getElementById("serviceTypeCatId").value = catId;
    initDeliverables("serviceTypeDeliverablesContainer");
  }
  openModal("serviceTypeModal");
}

async function saveServiceType(e) {
  e.preventDefault();
  const catId  = document.getElementById("serviceTypeCatId").value;
  const typeId = document.getElementById("serviceTypeEditId").value;
  const svc    = cache.services.find(s => s.id === catId); if (!svc) return;
  const types  = [...(svc.types || [])];
  const newType = {
    id:           typeId || `t_${Date.now()}`,
    typeName:     document.getElementById("serviceTypeName").value.trim(),
    basePrice:    parseFloat(document.getElementById("serviceTypePrice").value) || 0,
    description:  document.getElementById("serviceTypeDesc").value.trim(),
    deliverables: collectDeliverables("serviceTypeDeliverablesContainer"),
  };

  const idx = types.findIndex(t => t.id === typeId);
  if (idx > -1) types[idx] = newType;
  else          types.push(newType);

  try {
    await updateDoc(doc(db, "services", catId), { types });
    svc.types = types;
    closeModal("serviceTypeModal");
    renderServicesPage();
    // Re-expand the category that was being edited
    setTimeout(() => {
      const body = document.getElementById(`svcBody_${catId}`);
      const chev = document.getElementById(`chevron_${catId}`);
      if (body && !body.classList.contains("open")) { body.classList.add("open"); chev?.classList.add("open"); }
    }, 50);
    toast(typeId ? "Plan updated" : "Plan added");
  } catch (err) { toast("Error: " + err.message, "error"); }
}

async function deleteServiceType(catId, typeId) {
  const svc = cache.services.find(s => s.id === catId); if (!svc) return;
  const types = (svc.types || []).filter(t => t.id !== typeId);
  try {
    await updateDoc(doc(db, "services", catId), { types });
    svc.types = types;
    renderServicesPage();
    toast("Plan deleted");
  } catch (err) { toast("Error: " + err.message, "error"); }
}

// ═══════════════════════════════════════════════════════════
// PROJECTS
// ═══════════════════════════════════════════════════════════
function openProjectModal(editId = null) {
  document.getElementById("projectEditId").value = editId || "";
  document.getElementById("projectModalTitle").textContent = editId ? "Edit Project" : "New Project";
  document.getElementById("projectForm").reset();
  populateSelect("projectClientTarget", cache.clients, "companyName");

  // Populate service categories
  const catSel = document.getElementById("projectServiceCategory");
  catSel.innerHTML = `<option value="">— Select Category —</option>` +
    cache.services.map(s => `<option value="${s.id}">${s.categoryName}</option>`).join("");
  const typeSel = document.getElementById("projectServiceType");
  typeSel.innerHTML = `<option value="">— Select Category First —</option>`;
  typeSel.disabled = true;

  initDeliverables("projectDeliverablesList");

  if (editId) {
    const p = cache.projects.find(pr => pr.id === editId); if (!p) return;
    document.getElementById("projectName").value        = p.projectName  || "";
    document.getElementById("projectDescription").value = p.description  || "";
    document.getElementById("projectStatus").value      = p.status       || "Active";
    document.getElementById("projectDrive").value       = p.driveLink    || "";
    document.getElementById("projectPrice").value       = p.projectPrice || "";
    populateSelect("projectClientTarget", cache.clients, "companyName", p.clientId);
    if (p.serviceCategoryId) {
      document.getElementById("projectServiceCategory").value = p.serviceCategoryId;
      populateServiceTypeDropdown(p.serviceCategoryId, p.serviceTypeId);
    }
    populateDeliverables("projectDeliverablesList", p.deliverables || []);
  }
  openModal("projectModal");
}

function populateServiceTypeDropdown(catId, selectedTypeId = "") {
  const svc  = cache.services.find(s => s.id === catId);
  const sel  = document.getElementById("projectServiceType");
  sel.disabled = false;
  sel.innerHTML = `<option value="">— Select Plan —</option>
    <option value="custom" ${selectedTypeId === "custom" ? "selected" : ""}>Custom (manual entry)</option>` +
    (svc?.types || []).map(t =>
      `<option value="${t.id}" ${t.id === selectedTypeId ? "selected" : ""}>${t.typeName} — ${fmt(t.basePrice)}</option>`
    ).join("");
}

function onServiceCategoryChange() {
  const catId = document.getElementById("projectServiceCategory").value;
  if (!catId) {
    const sel = document.getElementById("projectServiceType");
    sel.innerHTML = `<option value="">— Select Category First —</option>`;
    sel.disabled = true;
    initDeliverables("projectDeliverablesList");
    document.getElementById("projectPrice").value = "";
    return;
  }
  populateServiceTypeDropdown(catId);
  initDeliverables("projectDeliverablesList");
  document.getElementById("projectPrice").value = "";
}

function onServiceTypeChange() {
  const catId  = document.getElementById("projectServiceCategory").value;
  const typeId = document.getElementById("projectServiceType").value;
  if (!typeId || typeId === "custom") {
    initDeliverables("projectDeliverablesList");
    document.getElementById("projectPrice").value = "";
    return;
  }
  const svc  = cache.services.find(s => s.id === catId);
  const type = svc?.types?.find(t => t.id === typeId);
  if (!type) return;
  populateDeliverables("projectDeliverablesList", type.deliverables || []);
  document.getElementById("projectPrice").value = type.basePrice || "";
}

function renderProjectsTable() {
  const q = (document.getElementById("projectSearch")?.value || "").toLowerCase();
  const rows = cache.projects.filter(p => !q || p.projectName?.toLowerCase().includes(q) || clientName(p.clientId).toLowerCase().includes(q));
  document.getElementById("projectsTableBody").innerHTML = rows.length ? rows.map(p => {
    const mCount = (p.milestones || []).length;
    const mLabel = mCount ? `<span style="font-size:11px;color:var(--text-3)">${mCount} milestone${mCount!==1?"s":""}</span>` : "—";
    return `<tr>
      <td><strong>${p.projectName}</strong></td>
      <td>${clientName(p.clientId)}</td>
      <td><span style="font-size:12px;color:var(--text-2)">${p.serviceCategoryName || "—"}${p.serviceTypeName ? ` · ${p.serviceTypeName}` : ""}</span></td>
      <td>${mLabel}</td>
      <td>${statusBadge(p.status || "Active")}</td>
      <td>${p.driveLink ? `<a href="${p.driveLink}" target="_blank" class="link-sm"><i class="fa-brands fa-google-drive"></i> Open</a>` : "—"}</td>
      <td><div class="row-actions">
        <button class="btn-icon" title="Milestones" data-progress-proj="${p.id}"><i class="fa-solid fa-list-check"></i></button>
        <button class="btn-icon" title="Edit" data-edit-proj="${p.id}"><i class="fa-solid fa-pen"></i></button>
        <button class="btn-icon danger" title="Delete" data-del-proj="${p.id}"><i class="fa-solid fa-trash"></i></button>
      </div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="7" class="empty-row">No projects found</td></tr>`;

  document.querySelectorAll("[data-progress-proj]").forEach(b => b.addEventListener("click", () => openProgressModal(b.dataset.progressProj)));
  document.querySelectorAll("[data-edit-proj]").forEach(b  => b.addEventListener("click", () => openProjectModal(b.dataset.editProj)));
  document.querySelectorAll("[data-del-proj]").forEach(b   => b.addEventListener("click", () =>
    confirmAction("Delete this project?", () => deleteItem("projects", b.dataset.delProj, "projects", renderProjectsTable))));
}

async function saveProject(e) {
  e.preventDefault();
  const editId   = document.getElementById("projectEditId").value;
  const catId    = document.getElementById("projectServiceCategory").value;
  const typeId   = document.getElementById("projectServiceType").value;
  const svc      = cache.services.find(s => s.id === catId);
  const typeObj  = svc?.types?.find(t => t.id === typeId);
  const data = {
    projectName:          document.getElementById("projectName").value.trim(),
    clientId:             document.getElementById("projectClientTarget").value,
    description:          document.getElementById("projectDescription").value.trim(),
    status:               document.getElementById("projectStatus").value,
    driveLink:            document.getElementById("projectDrive").value.trim(),
    serviceCategoryId:    catId    || "",
    serviceCategoryName:  svc?.categoryName || "",
    serviceTypeId:        typeId   || "",
    serviceTypeName:      typeObj?.typeName || (typeId === "custom" ? "Custom" : ""),
    deliverables:         collectDeliverables("projectDeliverablesList"),
    projectPrice:         parseFloat(document.getElementById("projectPrice").value) || 0,
  };
  try {
    if (editId) {
      await updateDoc(doc(db, "projects", editId), data);
      const i = cache.projects.findIndex(p => p.id === editId);
      if (i > -1) cache.projects[i] = { id: editId, ...data };
    } else {
      const ref = await addDoc(collection(db, "projects"), data);
      cache.projects.push({ id: ref.id, ...data });
    }
    closeModal("projectModal");
    renderProjectsTable();
    toast(editId ? "Project updated" : "Project created");
  } catch (err) { toast("Error: " + err.message, "error"); }
}

// ═══════════════════════════════════════════════════════════
// INVOICES
// ═══════════════════════════════════════════════════════════
function renderInvoicesTable() {
  const q      = (document.getElementById("invoiceSearch")?.value || "").toLowerCase();
  const status = document.getElementById("invoiceStatusFilter")?.value || "";
  const rows   = cache.invoices.filter(inv =>
    (!q || inv.invoiceNumber?.toLowerCase().includes(q) || clientName(inv.clientId).toLowerCase().includes(q)) &&
    (!status || inv.status === status));
  document.getElementById("invoicesTableBody").innerHTML = rows.length ? rows.map(inv => `<tr>
    <td class="mono"><strong>${inv.invoiceNumber}</strong></td>
    <td>${clientName(inv.clientId)}</td>
    <td class="mono">${inv.dateIssued || "—"}</td>
    <td class="mono">${inv.dueDate    || "—"}</td>
    <td class="mono">${fmt(inv.grossTotal)}</td>
    <td>${statusBadge(inv.status)}</td>
    <td><div class="row-actions">
      <button class="btn-icon" title="PDF" data-pdf-inv="${inv.id}"><i class="fa-solid fa-file-pdf"></i></button>
      <button class="btn-icon" title="Edit" data-edit-inv="${inv.id}"><i class="fa-solid fa-pen"></i></button>
      <button class="btn-icon danger" title="Delete" data-del-inv="${inv.id}"><i class="fa-solid fa-trash"></i></button>
    </div></td>
  </tr>`).join("") : `<tr><td colspan="7" class="empty-row">No invoices found</td></tr>`;

  document.querySelectorAll("[data-pdf-inv]").forEach(b  => b.addEventListener("click", () => printInvoicePDF(b.dataset.pdfInv)));
  document.querySelectorAll("[data-edit-inv]").forEach(b => b.addEventListener("click", () => editInvoice(b.dataset.editInv)));
  document.querySelectorAll("[data-del-inv]").forEach(b  => b.addEventListener("click", () =>
    confirmAction("Delete this invoice?", () => deleteItem("invoices", b.dataset.delInv, "invoices", renderInvoicesTable))));
}

async function saveInvoice(e) {
  e.preventDefault();
  const editId  = document.getElementById("invoiceEditId").value;
  const items   = collectLineItems("invoiceLineItems");
  if (!items.length) { toast("Add at least one line item", "warning"); return; }
  const sub     = items.reduce((a, i) => a + i.total, 0);
  const discPct = parseFloat(document.getElementById("invoiceDiscount").value) || 0;
  const taxPct  = parseFloat(document.getElementById("invoiceTaxRate").value)  || 0;
  const disc    = sub * (discPct / 100);
  const tax     = (sub - disc) * (taxPct / 100);
  const existing = editId ? cache.invoices.find(i => i.id === editId) : null;
  const data = {
    invoiceNumber: existing?.invoiceNumber || genNumber("INV", cache.invoices),
    clientId:   document.getElementById("invoiceClientTarget").value,
    dateIssued: document.getElementById("invoiceDate").value,
    dueDate:    document.getElementById("invoiceDueDate").value,
    taxRate: taxPct, discount: discPct,
    items, subtotal: sub, discountAmount: disc, taxAmount: tax,
    grossTotal: sub - disc + tax,
    notes:  document.getElementById("invoiceNotes").value.trim(),
    status: existing?.status || "UNPAID",
    projectId:   document.getElementById("invoiceProjectTarget")?.value || "",
    paymentType: document.getElementById("invoicePaymentType")?.value   || "Full Payment",
  };
  // Attach project details for PDF reference
  const proj = cache.projects.find(p => p.id === data.projectId);
  if (proj) {
    data.projectName         = proj.projectName;
    data.serviceCategoryName = proj.serviceCategoryName || "";
    data.serviceTypeName     = proj.serviceTypeName     || "";
    data.deliverables        = proj.deliverables        || [];
  }
  try {
    if (editId) {
      await updateDoc(doc(db, "invoices", editId), data);
      const i = cache.invoices.findIndex(inv => inv.id === editId);
      if (i > -1) cache.invoices[i] = { id: editId, ...data };
    } else {
      const ref = await addDoc(collection(db, "invoices"), data);
      cache.invoices.unshift({ id: ref.id, ...data });
    }
    closeModal("invoiceModal");
    renderInvoicesTable();
    renderAdminDashboard();
    toast(editId ? "Invoice updated" : "Invoice created");
  } catch (err) { toast("Error: " + err.message, "error"); }
}

function editInvoice(id) {
  const inv = cache.invoices.find(i => i.id === id); if (!inv) return;
  document.getElementById("invoiceEditId").value = id;
  document.getElementById("invoiceModalTitle").textContent = "Edit Invoice";
  populateSelect("invoiceClientTarget", cache.clients, "companyName", inv.clientId);
  document.getElementById("invoiceDate").value     = inv.dateIssued || "";
  document.getElementById("invoiceDueDate").value  = inv.dueDate    || "";
  document.getElementById("invoiceTaxRate").value  = inv.taxRate    || 0;
  document.getElementById("invoiceDiscount").value = inv.discount   || 0;
  document.getElementById("invoiceNotes").value    = inv.notes      || "";
  // Restore payment type
  const ptEl = document.getElementById("invoicePaymentType");
  if (ptEl) ptEl.value = inv.paymentType || "Full Payment";
  // Restore project dropdown
  const clientProjects = cache.projects.filter(p => p.clientId === inv.clientId);
  const projSel = document.getElementById("invoiceProjectTarget");
  projSel.innerHTML = '<option value="">— None / Select Project —</option>' +
    clientProjects.map(p => `<option value="${p.id}" ${p.id === inv.projectId ? "selected" : ""}>${p.projectName}${p.serviceTypeName ? ' · ' + p.serviceTypeName : ''}</option>`).join('');
  populateLineItems("invoiceLineItems", inv.items || [], calcInvoiceTotals);
  calcInvoiceTotals();
  openModal("invoiceModal");
}

// ═══════════════════════════════════════════════════════════
// RECEIPTS
// ═══════════════════════════════════════════════════════════
function renderReceiptsTable() {
  const q = (document.getElementById("receiptSearch")?.value || "").toLowerCase();
  const rows = cache.receipts.filter(r =>
    !q || r.receiptNumber?.toLowerCase().includes(q) || clientName(r.clientId).toLowerCase().includes(q));
  document.getElementById("receiptsTableBody").innerHTML = rows.length ? rows.map(r => `<tr>
    <td class="mono"><strong>${r.receiptNumber}</strong></td>
    <td class="mono">${r.invoiceNumber || "—"}</td>
    <td>${clientName(r.clientId)}</td>
    <td class="mono">${r.dateSettled || "—"}</td>
    <td class="mono">${fmt(r.amountPaid)}</td>
    <td>${r.paymentMethod || "—"}</td>
    <td><div class="row-actions">
      <button class="btn-icon" data-pdf-rec="${r.id}"><i class="fa-solid fa-file-pdf"></i></button>
      <button class="btn-icon danger" data-del-rec="${r.id}"><i class="fa-solid fa-trash"></i></button>
    </div></td>
  </tr>`).join("") : `<tr><td colspan="7" class="empty-row">No receipts found</td></tr>`;

  document.querySelectorAll("[data-pdf-rec]").forEach(b => b.addEventListener("click", () => printReceiptPDF(b.dataset.pdfRec)));
  document.querySelectorAll("[data-del-rec]").forEach(b => b.addEventListener("click", () =>
    confirmAction("Delete this receipt?", () => deleteItem("receipts", b.dataset.delRec, "receipts", renderReceiptsTable))));
}

async function saveReceipt(e) {
  e.preventDefault();
  const invId = document.getElementById("receiptInvoiceTarget").value;
  const inv   = cache.invoices.find(i => i.id === invId);
  if (!inv) { toast("Select a valid invoice", "warning"); return; }
  const data = {
    receiptNumber: genNumber("REC", cache.receipts),
    invoiceId:     invId, invoiceNumber: inv.invoiceNumber, clientId: inv.clientId,
    dateSettled:   document.getElementById("receiptDate").value,
    amountPaid:    parseFloat(document.getElementById("receiptAmount").value) || 0,
    paymentType:   document.getElementById("receiptPaymentType")?.value || "Full Payment",
    paymentMethod: document.getElementById("receiptMethod").value,
    notes:         document.getElementById("receiptNotes").value.trim(),
    // Carry over project/service info from invoice for PDF
    projectId:           inv.projectId           || "",
    projectName:         inv.projectName         || "",
    serviceCategoryName: inv.serviceCategoryName || "",
    serviceTypeName:     inv.serviceTypeName     || "",
    deliverables:        inv.deliverables        || [],
  };
  try {
    const ref = await addDoc(collection(db, "receipts"), data);
    cache.receipts.unshift({ id: ref.id, ...data });
    await updateDoc(doc(db, "invoices", invId), { status: "PAID" });
    const inv2 = cache.invoices.find(i => i.id === invId);
    if (inv2) inv2.status = "PAID";
    closeModal("receiptModal");
    renderReceiptsTable();
    renderAdminDashboard();
    toast("Receipt saved — invoice marked PAID");
  } catch (err) { toast("Error: " + err.message, "error"); }
}

// ═══════════════════════════════════════════════════════════
// QUOTES
// ═══════════════════════════════════════════════════════════
function renderQuotesTable() {
  const q = (document.getElementById("quoteSearch")?.value || "").toLowerCase();
  const rows = cache.quotes.filter(qt =>
    !q || qt.quoteNumber?.toLowerCase().includes(q) || clientName(qt.clientId).toLowerCase().includes(q));
  document.getElementById("quotesTableBody").innerHTML = rows.length ? rows.map(qt => `<tr>
    <td class="mono"><strong>${qt.quoteNumber}</strong></td>
    <td>${clientName(qt.clientId)}</td>
    <td class="mono">${qt.dateCreated || "—"}</td>
    <td class="mono">${qt.validUntil  || "—"}</td>
    <td class="mono">${fmt(qt.grossTotal)}</td>
    <td>${statusBadge(qt.status || "PROPOSED")}</td>
    <td><div class="row-actions">
      <button class="btn-icon" data-pdf-qt="${qt.id}"><i class="fa-solid fa-file-pdf"></i></button>
      ${qt.status === "PROPOSED" ? `<button class="btn-icon" title="Convert to Invoice" data-convert-qt="${qt.id}"><i class="fa-solid fa-wand-magic-sparkles"></i></button>` : ""}
      <button class="btn-icon danger" data-del-qt="${qt.id}"><i class="fa-solid fa-trash"></i></button>
    </div></td>
  </tr>`).join("") : `<tr><td colspan="7" class="empty-row">No quotes found</td></tr>`;

  document.querySelectorAll("[data-pdf-qt]").forEach(b    => b.addEventListener("click", () => printQuotePDF(b.dataset.pdfQt)));
  document.querySelectorAll("[data-convert-qt]").forEach(b=> b.addEventListener("click", () => convertQuoteToInvoice(b.dataset.convertQt)));
  document.querySelectorAll("[data-del-qt]").forEach(b    => b.addEventListener("click", () =>
    confirmAction("Delete this quote?", () => deleteItem("quotes", b.dataset.delQt, "quotes", renderQuotesTable))));
}

async function saveQuote(e) {
  e.preventDefault();
  const items = collectLineItems("quoteLineItems");
  if (!items.length) { toast("Add at least one line item", "warning"); return; }
  const sub    = items.reduce((a, i) => a + i.total, 0);
  const taxPct = parseFloat(document.getElementById("quoteTaxRate").value) || 0;
  const tax    = sub * (taxPct / 100);
  const data = {
    quoteNumber:  genNumber("QUO", cache.quotes),
    clientId:     document.getElementById("quoteClientTarget").value,
    dateCreated:  document.getElementById("quoteDate").value,
    validUntil:   document.getElementById("quoteValidUntil").value,
    taxRate: taxPct, items, subtotal: sub, taxAmount: tax,
    grossTotal: sub + tax, status: "PROPOSED",
  };
  try {
    const ref = await addDoc(collection(db, "quotes"), data);
    cache.quotes.unshift({ id: ref.id, ...data });
    closeModal("quoteModal");
    renderQuotesTable();
    toast("Quote created");
  } catch (err) { toast("Error: " + err.message, "error"); }
}

async function convertQuoteToInvoice(quoteId) {
  const qt = cache.quotes.find(q => q.id === quoteId); if (!qt) return;
  const due = new Date(); due.setDate(due.getDate() + 30);
  const data = {
    invoiceNumber: genNumber("INV", cache.invoices),
    clientId: qt.clientId, dateIssued: today(),
    dueDate: due.toISOString().split("T")[0],
    taxRate: qt.taxRate, discount: 0,
    items: qt.items, subtotal: qt.subtotal,
    discountAmount: 0, taxAmount: qt.taxAmount,
    grossTotal: qt.grossTotal, status: "UNPAID",
    notes: `Converted from ${qt.quoteNumber}`,
  };
  try {
    const ref = await addDoc(collection(db, "invoices"), data);
    cache.invoices.unshift({ id: ref.id, ...data });
    await updateDoc(doc(db, "quotes", quoteId), { status: "CONVERTED" });
    cache.quotes.find(q => q.id === quoteId).status = "CONVERTED";
    renderQuotesTable();
    toast(`Invoice ${data.invoiceNumber} created from quote`);
  } catch (err) { toast("Error: " + err.message, "error"); }
}

// ═══════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════
function renderReports() {
  const paid    = cache.invoices.filter(i => i.status === "PAID").reduce((a, i)    => a + i.grossTotal, 0);
  const unpaid  = cache.invoices.filter(i => i.status === "UNPAID").reduce((a, i)  => a + i.grossTotal, 0);
  const overdue = cache.invoices.filter(i => i.status === "OVERDUE").reduce((a, i) => a + i.grossTotal, 0);
  const total   = paid + unpaid + overdue || 1;
  document.getElementById("revenueBreakdown").innerHTML = `<div class="revenue-bar-wrap">
    ${[["Collected", paid, "var(--green-600)"], ["Unpaid", unpaid, "var(--amber-600)"], ["Overdue", overdue, "var(--red-600)"]].map(([label, val, color]) => `
    <div class="revenue-bar-item">
      <div class="revenue-bar-label"><span>${label}</span><span>${fmt(val)}</span></div>
      <div class="revenue-bar"><div class="revenue-bar-fill" style="width:${(val/total*100).toFixed(1)}%;background:${color}"></div></div>
    </div>`).join("")}
  </div>`;

  const rev = {};
  cache.receipts.forEach(r => { rev[r.clientId] = (rev[r.clientId] || 0) + r.amountPaid; });
  const ranked = Object.entries(rev).sort((a, b) => b[1] - a[1]).slice(0, 5);
  document.getElementById("topClientsReport").innerHTML = ranked.length ?
    `<div class="client-rank">${ranked.map(([cid, val], i) => `
      <div class="client-rank-item">
        <span class="rank-num">${i + 1}</span>
        <span class="rank-name">${clientName(cid)}</span>
        <span class="rank-val">${fmt(val)}</span>
      </div>`).join("")}</div>` : `<p class="empty-row">No payment data yet</p>`;

  const overdueInvs = cache.invoices.filter(i => i.status === "OVERDUE");
  document.getElementById("overdueReport").innerHTML = overdueInvs.length ?
    overdueInvs.map(inv => `<tr>
      <td class="mono"><strong>${inv.invoiceNumber}</strong></td>
      <td>${clientName(inv.clientId)}</td>
      <td class="mono">${inv.dueDate}</td>
      <td class="mono">${fmt(inv.grossTotal)}</td>
      <td><span class="badge badge-overdue">${daysOverdue(inv.dueDate)} days</span></td>
    </tr>`).join("") : `<tr><td colspan="5" class="empty-row">No overdue invoices</td></tr>`;
}

// ═══════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════
function renderSettings() {
  document.getElementById("settingAgencyName").value = agencySettings.agencyName || "";
  document.getElementById("settingCurrency").value   = agencySettings.currency   || "";
  document.getElementById("settingEmail").value      = agencySettings.email      || "";
  document.getElementById("settingPhone").value      = agencySettings.phone      || "";
  document.getElementById("settingAddress").value    = agencySettings.address    || "";
  document.getElementById("settingLogoUrl").value    = agencySettings.logoUrl    || "";
  document.getElementById("settingFooter").value     = agencySettings.footer     || "";
}

async function saveSettings(e) {
  e.preventDefault();
  const data = {
    agencyName: document.getElementById("settingAgencyName").value.trim(),
    currency:   document.getElementById("settingCurrency").value.trim() || "GHS",
    email:      document.getElementById("settingEmail").value.trim(),
    phone:      document.getElementById("settingPhone").value.trim(),
    address:    document.getElementById("settingAddress").value.trim(),
    logoUrl:    document.getElementById("settingLogoUrl").value.trim(),
    footer:     document.getElementById("settingFooter").value.trim(),
  };
  try {
    await setDoc(doc(db, "settings", "global"), data);
    agencySettings = data;
    document.getElementById("topbarAgency").textContent = data.agencyName;
    toast("Settings saved");
  } catch (err) { toast("Error: " + err.message, "error"); }
}

// ═══════════════════════════════════════════════════════════
// DELETE HELPER
// ═══════════════════════════════════════════════════════════
async function deleteItem(collName, id, cacheKey, rerenderFn) {
  try {
    await deleteDoc(doc(db, collName, id));
    cache[cacheKey] = cache[cacheKey].filter(i => i.id !== id);
    rerenderFn();
    toast("Deleted");
  } catch (err) { toast("Error: " + err.message, "error"); }
}

// ═══════════════════════════════════════════════════════════
// CLIENT PORTAL
// ═══════════════════════════════════════════════════════════
const myItems = {
  invoices: () => cache.invoices.filter(i => i.clientId === currentUser?.clientId),
  receipts: () => cache.receipts.filter(r => r.clientId === currentUser?.clientId),
  quotes:   () => cache.quotes.filter(q   => q.clientId === currentUser?.clientId),
  projects: () => cache.projects.filter(p => p.clientId === currentUser?.clientId),
};

function renderClientDashboard() {
  const invs   = myItems.invoices();
  const unpaid = invs.filter(i => i.status !== "PAID").reduce((a, i) => a + i.grossTotal, 0);
  const paid   = invs.filter(i => i.status === "PAID").reduce((a, i) => a + i.grossTotal, 0);
  document.getElementById("cStatInvoices").textContent = invs.length;
  document.getElementById("cStatUnpaid").textContent   = fmt(unpaid);
  document.getElementById("cStatPaid").textContent     = fmt(paid);
  document.getElementById("cStatProjects").textContent = myItems.projects().length;
  const tbody = document.getElementById("clientDashInvoices");
  tbody.innerHTML = invs.slice(0,5).map(inv => `<tr>
    <td class="mono"><strong>${inv.invoiceNumber}</strong></td>
    <td class="mono">${fmt(inv.grossTotal)}</td>
    <td class="mono">${inv.dueDate || "—"}</td>
    <td>${statusBadge(inv.status)}</td>
    <td><button class="btn-icon" data-cpdf-inv="${inv.id}"><i class="fa-solid fa-download"></i></button></td>
  </tr>`).join("") || `<tr><td colspan="5" class="empty-row">No invoices yet</td></tr>`;
  tbody.querySelectorAll("[data-cpdf-inv]").forEach(b => b.addEventListener("click", () => printInvoicePDF(b.dataset.cpdfInv)));
}

function renderClientInvoices() {
  const tbody = document.getElementById("clientInvoicesBody");
  tbody.innerHTML = myItems.invoices().map(inv => `<tr>
    <td class="mono"><strong>${inv.invoiceNumber}</strong></td>
    <td class="mono">${inv.dateIssued || "—"}</td>
    <td class="mono">${inv.dueDate    || "—"}</td>
    <td class="mono">${fmt(inv.grossTotal)}</td>
    <td>${statusBadge(inv.status)}</td>
    <td><button class="btn-icon" data-cpdf-inv="${inv.id}"><i class="fa-solid fa-download"></i></button></td>
  </tr>`).join("") || `<tr><td colspan="6" class="empty-row">No invoices</td></tr>`;
  tbody.querySelectorAll("[data-cpdf-inv]").forEach(b => b.addEventListener("click", () => printInvoicePDF(b.dataset.cpdfInv)));
}

function renderClientReceipts() {
  const tbody = document.getElementById("clientReceiptsBody");
  tbody.innerHTML = myItems.receipts().map(r => `<tr>
    <td class="mono"><strong>${r.receiptNumber}</strong></td>
    <td class="mono">${r.invoiceNumber || "—"}</td>
    <td class="mono">${r.dateSettled   || "—"}</td>
    <td class="mono">${fmt(r.amountPaid)}</td>
    <td>${r.paymentMethod || "—"}</td>
    <td><button class="btn-icon" data-cpdf-rec="${r.id}"><i class="fa-solid fa-download"></i></button></td>
  </tr>`).join("") || `<tr><td colspan="6" class="empty-row">No receipts</td></tr>`;
  tbody.querySelectorAll("[data-cpdf-rec]").forEach(b => b.addEventListener("click", () => printReceiptPDF(b.dataset.cpdfRec)));
}

function renderClientQuotes() {
  const tbody = document.getElementById("clientQuotesBody");
  tbody.innerHTML = myItems.quotes().map(qt => `<tr>
    <td class="mono"><strong>${qt.quoteNumber}</strong></td>
    <td class="mono">${qt.dateCreated || "—"}</td>
    <td class="mono">${qt.validUntil  || "—"}</td>
    <td class="mono">${fmt(qt.grossTotal)}</td>
    <td>${statusBadge(qt.status)}</td>
    <td><button class="btn-icon" data-cpdf-qt="${qt.id}"><i class="fa-solid fa-download"></i></button></td>
  </tr>`).join("") || `<tr><td colspan="6" class="empty-row">No quotes</td></tr>`;
  tbody.querySelectorAll("[data-cpdf-qt]").forEach(b => b.addEventListener("click", () => printQuotePDF(b.dataset.cpdfQt)));
}

function renderClientProjects() {
  const projects = myItems.projects();
  document.getElementById("clientProjectsGrid").innerHTML = projects.length ? projects.map(p => {
    const milestones = p.milestones || [];
    return `
    <div class="project-card">
      <div class="project-card-name">${p.projectName}</div>
      ${p.serviceCategoryName ? `<div class="project-card-service"><i class="fa-solid fa-briefcase"></i> ${p.serviceCategoryName}${p.serviceTypeName ? ` · ${p.serviceTypeName}` : ""}</div>` : ""}
      ${p.description ? `<div class="project-card-desc">${p.description}</div>` : ""}

      ${milestones.length ? `
        <div class="project-milestones-wrap">
          <div class="project-milestones-title">Milestones</div>
          <div class="project-milestones-timeline">
            ${milestones.map(m => `
              <div class="project-milestone-item">
                <div class="project-milestone-dot ${m.date ? "done" : "pending"}">
                  <i class="fa-solid ${m.date ? "fa-check" : "fa-circle"}"></i>
                </div>
                <div class="project-milestone-body">
                  <div class="project-milestone-name">
                    <span>${m.name}</span>
                    ${m.date ? `<span class="project-milestone-date">${m.date}</span>` : ""}
                  </div>
                  ${m.note ? `<div class="project-milestone-note">${m.note}</div>` : ""}
                </div>
              </div>`).join("")}
          </div>
        </div>` : ""}

      ${p.deliverables?.length ? `
        <div class="project-card-deliverables">
          <div class="project-card-deliverables-title">Scope of Work</div>
          ${p.deliverables.map(d => `<div class="project-card-deliverable"><i class="fa-solid fa-circle-check"></i>${d}</div>`).join("")}
        </div>` : ""}

      <div class="project-card-footer">
        ${statusBadge(p.status || "Active")}
        ${p.projectPrice ? `<span style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--green-600)">${fmt(p.projectPrice)}</span>` : ""}
        ${p.driveLink ? `<a href="${p.driveLink}" target="_blank" class="project-drive-btn"><i class="fa-brands fa-google-drive"></i> Files</a>` : ""}
      </div>
    </div>`;
  }).join("") : `<p style="color:var(--text-3);padding:20px">No projects yet.</p>`;
}

function renderClientPassword() {
  document.getElementById("changePasswordForm").reset();
  document.getElementById("passwordChangeError").classList.add("hide");
  document.getElementById("passwordChangeSuccess").classList.add("hide");
}

async function saveClientPassword(e) {
  e.preventDefault();
  const errEl     = document.getElementById("passwordChangeError");
  const successEl = document.getElementById("passwordChangeSuccess");
  const btn       = document.getElementById("changePasswordBtn");
  const current   = document.getElementById("currentPassword").value;
  const newPw     = document.getElementById("newPassword").value;
  const confirm   = document.getElementById("confirmPassword").value;
  errEl.classList.add("hide");
  successEl.classList.add("hide");
  if (newPw.length < 6)    { errEl.textContent = "New password must be at least 6 characters."; errEl.classList.remove("hide"); return; }
  if (newPw !== confirm)   { errEl.textContent = "Passwords do not match."; errEl.classList.remove("hide"); return; }
  btn.disabled = true; btn.textContent = "Updating…";
  try {
    const user       = auth.currentUser;
    const credential = EmailAuthProvider.credential(user.email, current);
    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, newPw);
    successEl.textContent = "Password updated successfully.";
    successEl.classList.remove("hide");
    document.getElementById("changePasswordForm").reset();
  } catch (err) {
    const msgs = {
      "auth/wrong-password":          "Current password is incorrect.",
      "auth/too-many-requests":       "Too many attempts. Try again later.",
      "auth/requires-recent-login":   "Session expired. Please log out and log in again.",
    };
    errEl.textContent = msgs[err.code] || err.message;
    errEl.classList.remove("hide");
  } finally { btn.disabled = false; btn.textContent = "Update Password"; }
}

// ═══════════════════════════════════════════════════════════
// PROJECT PROGRESS ENGINE  (milestones: name + date + note)
// ═══════════════════════════════════════════════════════════
function addMilestoneRow(name = "", date = "", note = "") {
  const container = document.getElementById("progressMilestonesList");
  const row       = document.createElement("div");
  row.className   = "milestone-row";
  row.innerHTML   = `
    <input type="text"     class="milestone-name" placeholder="Milestone name *" value="${name.replace(/"/g,'&quot;')}" />
    <input type="date"     class="milestone-date" value="${date}" />
    <button type="button"  class="remove-milestone-btn" title="Remove"><i class="fa-solid fa-xmark"></i></button>
    <textarea              class="milestone-note" rows="1" placeholder="Note (optional) — e.g. Approved by client, pending feedback…">${note}</textarea>
  `;
  container.appendChild(row);
  row.querySelector(".remove-milestone-btn").addEventListener("click", () => row.remove());
}

function collectMilestones() {
  return [...document.getElementById("progressMilestonesList").querySelectorAll(".milestone-row")]
    .map((row, i) => ({
      id:   `m_${Date.now()}_${i}`,
      name: row.querySelector(".milestone-name").value.trim(),
      date: row.querySelector(".milestone-date").value || "",
      note: row.querySelector(".milestone-note").value.trim(),
    }))
    .filter(m => m.name);
}

function openProgressModal(projectId) {
  const p = cache.projects.find(pr => pr.id === projectId);
  if (!p) return;
  document.getElementById("progressProjectId").value = projectId;
  document.getElementById("progressModalTitle").textContent = `Milestones: ${p.projectName}`;
  document.getElementById("progressMilestonesList").innerHTML = "";
  const milestones = p.milestones || [];
  if (milestones.length) {
    milestones.forEach(m => addMilestoneRow(m.name, m.date || m.completedAt || "", m.note || ""));
  } else {
    // Pre-fill from deliverables if no milestones yet
    (p.deliverables || []).forEach(d => addMilestoneRow(d, "", ""));
    if (!(p.deliverables || []).length) addMilestoneRow();
  }
  openModal("progressModal");
}

async function saveProgress(e) {
  e.preventDefault();
  const projectId = document.getElementById("progressProjectId").value;
  const milestones = collectMilestones();
  const data = {
    milestones,
    progressUpdatedAt: new Date().toISOString().split("T")[0],
  };
  try {
    await updateDoc(doc(db, "projects", projectId), data);
    const p = cache.projects.find(pr => pr.id === projectId);
    if (p) Object.assign(p, data);
    closeModal("progressModal");
    renderProjectsTable();
    toast("Milestones saved");
  } catch (err) { toast("Error: " + err.message, "error"); }
}

// ═══════════════════════════════════════════════════════════
// PDF ENGINE
// Logo recommended dimensions: 300 × 90 px (PNG, transparent bg)
// Rendered at 42mm × 13mm in the PDF header.
// ═══════════════════════════════════════════════════════════
async function loadLogo() {
  const url = agencySettings.logoUrl;
  if (!url) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.width; canvas.height = img.height;
        canvas.getContext("2d").drawImage(img, 0, 0);
        resolve({ data: canvas.toDataURL("image/png"), w: img.width, h: img.height });
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
    setTimeout(() => resolve(null), 4000);
  });
}

// ── Colours ──────────────────────────────────────────────
const PDF_GREEN  = [15, 61, 46];
const PDF_ACCENT = [22, 163, 74];
const PDF_LIGHT  = [235, 252, 240];
const PDF_GRAY   = [100, 116, 139];
const PDF_LGRAY  = [226, 232, 240];

function pdfFmt(n) {
  const sym = agencySettings.currency || "GHS";
  return `${sym} ${Number(n||0).toLocaleString("en-GH", { minimumFractionDigits:2 })}`;
}

async function pdfHeader(d, docType, docNumber) {
  const W = 210, m = 16;
  const logo = await loadLogo();

  // Header background
  d.setFillColor(...PDF_GREEN); d.rect(0, 0, W, 46, "F");

  // Logo (if available) — rendered at max 42mm wide, 13mm tall (aspect preserved)
  let textX = m;
  if (logo) {
    const aspect  = logo.w / logo.h;
    const maxW    = 42; const maxH = 13;
    const renderH = Math.min(maxH, maxW / aspect);
    const renderW = renderH * aspect;
    const logoY   = (46 - renderH) / 2;
    try { d.addImage(logo.data, "PNG", m, logoY, renderW, renderH); textX = m + renderW + 6; } catch {}
  }

  // Agency name & contact
  d.setTextColor(255, 255, 255);
  d.setFontSize(14); d.setFont("helvetica", "bold");
  d.text(agencySettings.agencyName || "Counterpane", textX, 17);
  d.setFontSize(7.5); d.setFont("helvetica", "normal"); d.setTextColor(200, 230, 210);
  let cy = 24;
  if (agencySettings.email)   { d.text(agencySettings.email,   textX, cy); cy += 6; }
  if (agencySettings.phone)   { d.text(agencySettings.phone,   textX, cy); cy += 6; }
  if (agencySettings.address) { d.text(agencySettings.address, textX, Math.min(cy, 40)); }

  // Document type badge (right side)
  const badgeW = 52; const badgeX = W - m - badgeW;
  d.setFillColor(255, 255, 255); d.roundedRect(badgeX, 10, badgeW, 12, 2, 2, "F");
  d.setTextColor(...PDF_GREEN); d.setFontSize(10); d.setFont("helvetica", "bold");
  d.text(docType, badgeX + badgeW / 2, 18.5, { align: "center" });

  // Document number below badge
  d.setTextColor(200, 230, 210); d.setFontSize(8); d.setFont("helvetica", "normal");
  d.text(docNumber, W - m, 30, { align: "right" });

  d.setTextColor(0, 0, 0);
  return 52;
}

function pdfClientBlock(d, y, obj) {
  const W = 210, m = 16;
  const client = cache.clients.find(c => c.id === obj.clientId) || {};

  // Two-column block: Bill To | Date/Due
  d.setFillColor(...PDF_LIGHT); d.rect(m, y, W - m*2, 28, "F");
  d.setDrawColor(...PDF_LGRAY); d.rect(m, y, W - m*2, 28, "S");

  // Left: client info
  d.setFontSize(7.5); d.setFont("helvetica", "bold"); d.setTextColor(...PDF_GRAY);
  d.text("BILL TO", m + 5, y + 6);
  d.setFont("helvetica", "bold"); d.setFontSize(10); d.setTextColor(15, 23, 42);
  d.text(client.companyName || "—", m + 5, y + 14);
  d.setFont("helvetica", "normal"); d.setFontSize(8); d.setTextColor(...PDF_GRAY);
  if (client.email)   d.text(client.email,   m + 5, y + 20);
  if (client.address) d.text(client.address, m + 5, y + 25);

  // Right: dates
  const midX = W - m - 64;
  d.setFontSize(7.5); d.setFont("helvetica", "bold"); d.setTextColor(...PDF_GRAY);
  d.text("DATE ISSUED",   midX, y + 6);
  d.text("DUE / VALID",   midX, y + 16);
  d.setFont("helvetica", "bold"); d.setFontSize(10); d.setTextColor(15, 23, 42);
  d.text(obj.dateIssued || "—", midX, y + 13);
  d.text(obj.dueDate    || "—", midX, y + 23);

  return y + 34;
}

function pdfServiceBlock(d, y, inv) {
  if (!inv.serviceCategoryName && !inv.serviceTypeName && !(inv.deliverables?.length)) return y;
  const W = 210, m = 16;

  // Section header
  d.setFillColor(...PDF_GREEN); d.rect(m, y, W - m*2, 8, "F");
  d.setFontSize(8); d.setFont("helvetica", "bold"); d.setTextColor(255, 255, 255);
  d.text("SCOPE OF WORK", m + 4, y + 5.5);
  y += 10;

  d.setFillColor(...PDF_LIGHT); d.rect(m, y, W - m*2, 1, "F");

  // Service + plan line
  if (inv.serviceCategoryName || inv.serviceTypeName || inv.paymentType) {
    d.setFillColor(248, 254, 250); d.rect(m, y, W - m*2, 9, "F");
    d.setFontSize(8); d.setFont("helvetica", "normal"); d.setTextColor(...PDF_GRAY);
    const serviceStr = [inv.serviceCategoryName, inv.serviceTypeName].filter(Boolean).join("  ›  ");
    if (serviceStr) d.text("Service:  " + serviceStr, m + 4, y + 6);
    if (inv.paymentType) d.text("Payment type:  " + inv.paymentType, W - m - 4, y + 6, { align: "right" });
    y += 11;
  }

  // Deliverables
  if (inv.deliverables?.length) {
    d.setFillColor(252, 253, 252); d.rect(m, y, W - m*2, inv.deliverables.length * 7 + 5, "F");
    d.setFontSize(8); d.setFont("helvetica", "bold"); d.setTextColor(15, 23, 42);
    d.text("Deliverables / Features:", m + 4, y + 6);
    y += 9;
    d.setFont("helvetica", "normal"); d.setTextColor(50, 65, 80);
    const cols = 2; const colW = (W - m*2 - 8) / cols;
    inv.deliverables.forEach((item, i) => {
      const col  = i % cols;
      const row  = Math.floor(i / cols);
      const xPos = m + 4 + col * colW;
      const yPos = y + row * 7;
      d.setTextColor(...PDF_ACCENT); d.text("✓", xPos, yPos + 4);
      d.setTextColor(50, 65, 80);   d.text(item, xPos + 5, yPos + 4);
    });
    y += Math.ceil(inv.deliverables.length / cols) * 7 + 4;
  }

  d.setDrawColor(...PDF_LGRAY); d.line(m, y, W - m, y);
  return y + 6;
}

function pdfItems(d, y, items) {
  const W = 210, m = 16;

  // Table header
  d.setFillColor(...PDF_GREEN); d.rect(m, y, W - m*2, 9, "F");
  d.setFontSize(8); d.setFont("helvetica", "bold"); d.setTextColor(255, 255, 255);
  d.text("DESCRIPTION", m + 4, y + 6);
  d.text("QTY",   128, y + 6, { align: "right" });
  d.text("RATE",  158, y + 6, { align: "right" });
  d.text("TOTAL", W - m, y + 6, { align: "right" });
  y += 11;

  d.setFont("helvetica", "normal"); d.setFontSize(9); d.setTextColor(15, 23, 42);
  items.forEach((item, i) => {
    const rowH = 8;
    if (i % 2 === 0) { d.setFillColor(250, 252, 250); d.rect(m, y, W - m*2, rowH, "F"); }
    else             { d.setFillColor(255, 255, 255); d.rect(m, y, W - m*2, rowH, "F"); }
    d.text(String(item.description || "").substring(0, 68), m + 4, y + 5.5);
    d.setTextColor(...PDF_GRAY);
    d.text(String(item.quantity), 128, y + 5.5, { align: "right" });
    d.text(pdfFmt(item.unitRate), 158, y + 5.5, { align: "right" });
    d.setTextColor(15, 23, 42); d.setFont("helvetica", "bold");
    d.text(pdfFmt(item.total), W - m, y + 5.5, { align: "right" });
    d.setFont("helvetica", "normal"); d.setTextColor(15, 23, 42);
    y += rowH;
  });

  // Bottom border
  d.setDrawColor(...PDF_LGRAY); d.line(m, y, W - m, y);
  return y + 5;
}

function pdfTotals(d, y, inv) {
  const W = 210, m = 16, labelX = 142, valX = W - m;
  d.setFontSize(9); d.setFont("helvetica", "normal");

  const rows = [
    ["Subtotal",  pdfFmt(inv.subtotal)],
    ...(inv.discountAmount > 0 ? [["Discount",  "-" + pdfFmt(inv.discountAmount)]] : []),
    ...(inv.taxAmount > 0      ? [["Tax / VAT",  pdfFmt(inv.taxAmount)]] : []),
  ];
  rows.forEach(([label, val]) => {
    d.setTextColor(...PDF_GRAY); d.text(label, labelX, y);
    d.setTextColor(15, 23, 42); d.text(val, valX, y, { align: "right" });
    y += 7;
  });

  // Grand total bar
  d.setFillColor(...PDF_GREEN); d.rect(labelX - 5, y - 2, W - labelX - m + 5 + 2, 11, "F");
  d.setTextColor(255, 255, 255); d.setFont("helvetica", "bold"); d.setFontSize(10);
  d.text("TOTAL DUE", labelX, y + 5.5);
  d.text(pdfFmt(inv.grossTotal), valX, y + 5.5, { align: "right" });

  return y + 18;
}

function pdfFooter(d, y) {
  const W = 210, m = 16;
  if (y > 270) { d.addPage(); y = 20; }
  // Footer bar
  d.setFillColor(...PDF_LIGHT); d.rect(0, y, W, 22, "F");
  d.setDrawColor(...PDF_ACCENT); d.setLineWidth(0.5); d.line(0, y, W, y);
  d.setLineWidth(0.2);
  y += 8;
  d.setFontSize(8); d.setFont("helvetica", "italic"); d.setTextColor(...PDF_GRAY);
  d.text(agencySettings.footer || "Thank you for your business.", W / 2, y, { align: "center" });
  if (agencySettings.email || agencySettings.phone) {
    d.setFont("helvetica", "normal");
    const contact = [agencySettings.email, agencySettings.phone].filter(Boolean).join("   |   ");
    d.text(contact, W / 2, y + 6, { align: "center" });
  }
}

async function printInvoicePDF(id) {
  const inv = cache.invoices.find(i => i.id === id); if (!inv) return;
  const { jsPDF } = window.jspdf;
  const d = new jsPDF();
  let y = await pdfHeader(d, "INVOICE", inv.invoiceNumber);
  y = pdfClientBlock(d, y, inv);
  y = pdfServiceBlock(d, y, inv);
  y = pdfItems(d, y, inv.items || []);
  y = pdfTotals(d, y, inv);
  if (inv.notes) {
    d.setFontSize(8.5); d.setFont("helvetica", "italic"); d.setTextColor(...PDF_GRAY);
    d.text("Note: " + inv.notes, 16, y); y += 8;
  }
  pdfFooter(d, y + 4);
  d.save(`${inv.invoiceNumber}.pdf`);
}

async function printReceiptPDF(id) {
  const r = cache.receipts.find(r => r.id === id); if (!r) return;
  const { jsPDF } = window.jspdf;
  const d = new jsPDF();
  const W = 210, m = 16;
  let y = await pdfHeader(d, "RECEIPT", r.receiptNumber);

  // Client block
  const client = cache.clients.find(c => c.id === r.clientId) || {};
  d.setFillColor(...PDF_LIGHT); d.rect(m, y, W - m*2, 22, "F");
  d.setDrawColor(...PDF_LGRAY); d.rect(m, y, W - m*2, 22, "S");
  d.setFontSize(7.5); d.setFont("helvetica", "bold"); d.setTextColor(...PDF_GRAY);
  d.text("RECEIVED FROM", m + 5, y + 6);
  d.text("PAYMENT DATE", W - m - 50, y + 6);
  d.setFont("helvetica", "bold"); d.setFontSize(10); d.setTextColor(15, 23, 42);
  d.text(client.companyName || "—", m + 5, y + 14);
  d.text(r.dateSettled || "—", W - m - 50, y + 14);
  y += 28;

  // Payment details block
  d.setFillColor(...PDF_LIGHT); d.rect(m, y, W - m*2, 9, "F");
  d.setFontSize(8); d.setFont("helvetica", "bold"); d.setTextColor(255, 255, 255);
  d.setFillColor(...PDF_GREEN); d.rect(m, y, W - m*2, 9, "F");
  d.text("PAYMENT DETAILS", m + 4, y + 6);
  y += 11;

  const rows = [
    ["Invoice Number",   r.invoiceNumber || "—"],
    ["Payment Type",     r.paymentType   || "—"],
    ["Payment Method",   r.paymentMethod || "—"],
    ...(r.notes ? [["Reference", r.notes]] : []),
  ];
  rows.forEach(([label, val], i) => {
    if (i % 2 === 0) { d.setFillColor(250, 252, 250); } else { d.setFillColor(255, 255, 255); }
    d.rect(m, y, W - m*2, 8, "F");
    d.setFontSize(8); d.setFont("helvetica", "normal"); d.setTextColor(...PDF_GRAY);
    d.text(label + ":", m + 4, y + 5.5);
    d.setTextColor(15, 23, 42); d.setFont("helvetica", "bold");
    d.text(val, m + 55, y + 5.5);
    y += 8;
  });
  y += 4;

  // Scope of work from project
  if (r.serviceCategoryName || r.serviceTypeName || r.deliverables?.length) {
    y = pdfServiceBlock(d, y, r);
  }

  // Confirmed amount
  d.setFillColor(...PDF_GREEN); d.rect(m, y, W - m*2, 14, "F");
  d.setTextColor(255, 255, 255); d.setFont("helvetica", "bold"); d.setFontSize(12);
  d.text("Amount Confirmed:", m + 6, y + 9.5);
  d.setFontSize(14);
  d.text(pdfFmt(r.amountPaid), W - m - 4, y + 9.5, { align: "right" });

  pdfFooter(d, y + 22);
  d.save(`${r.receiptNumber}.pdf`);
}

async function printQuotePDF(id) {
  const qt = cache.quotes.find(q => q.id === id); if (!qt) return;
  const { jsPDF } = window.jspdf;
  const d = new jsPDF();
  let y = await pdfHeader(d, "QUOTATION", qt.quoteNumber);
  y = pdfClientBlock(d, y, { ...qt, dateIssued: qt.dateCreated, dueDate: qt.validUntil });
  // Show scope from project if available
  const proj = cache.projects.find(p => p.clientId === qt.clientId && p.deliverables?.length);
  if (proj) y = pdfServiceBlock(d, y, { ...proj, paymentType: "" });
  y = pdfItems(d, y, qt.items || []);
  y = pdfTotals(d, y, { ...qt, discountAmount: 0 });
  pdfFooter(d, y + 4);
  d.save(`${qt.quoteNumber}.pdf`);
}

// ═══════════════════════════════════════════════════════════
// FIRESTORE RULES REMINDER (for services collection)
// Add this rule inside your Firestore rules:
//   match /services/{id} {
//     allow read, write: if isAdmin();
//     allow read: if isSignedIn();
//   }
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// INVOICE TEMPLATES ENGINE
// ═══════════════════════════════════════════════════════════
function calcTemplateTotals() {
  const items  = collectLineItems("templateLineItems");
  const sub    = items.reduce((a, i) => a + i.total, 0);
  const taxPct = parseFloat(document.getElementById("templateTaxRate").value) || 0;
  const tax    = sub * (taxPct / 100);
  document.getElementById("tmplSubtotal").textContent   = fmt(sub);
  document.getElementById("tmplTaxAmt").textContent     = fmt(tax);
  document.getElementById("tmplGrandTotal").textContent = fmt(sub + tax);
}

function openTemplateModal(editId = null) {
  document.getElementById("templateEditId").value = editId || "";
  document.getElementById("templateModalTitle").textContent = editId ? "Edit Template" : "New Invoice Template";
  document.getElementById("templateForm").reset();
  populateSelect("templateClientTarget", cache.clients, "companyName",
    editId ? (cache.templates.find(t => t.id === editId)?.clientId || "") : "");

  if (editId) {
    const t = cache.templates.find(t => t.id === editId);
    if (!t) return;
    document.getElementById("templateName").value        = t.templateName  || "";
    document.getElementById("templateFrequency").value  = t.frequency      || "Monthly";
    document.getElementById("templatePaymentType").value= t.paymentType    || "Full Payment";
    document.getElementById("templateTaxRate").value    = t.taxRate        || 0;
    document.getElementById("templateNotes").value      = t.notes          || "";
    populateLineItems("templateLineItems", t.items || [], calcTemplateTotals);
  } else {
    initLineItems("templateLineItems", calcTemplateTotals);
  }
  calcTemplateTotals();
  openModal("templateModal");
}

async function saveTemplate(e) {
  e.preventDefault();
  const editId = document.getElementById("templateEditId").value;
  const items  = collectLineItems("templateLineItems");
  if (!items.length) { toast("Add at least one line item", "warning"); return; }
  const sub    = items.reduce((a, i) => a + i.total, 0);
  const taxPct = parseFloat(document.getElementById("templateTaxRate").value) || 0;
  const tax    = sub * (taxPct / 100);
  const data   = {
    templateName:  document.getElementById("templateName").value.trim(),
    clientId:      document.getElementById("templateClientTarget").value,
    frequency:     document.getElementById("templateFrequency").value,
    paymentType:   document.getElementById("templatePaymentType").value,
    taxRate:       taxPct,
    items, subtotal: sub, taxAmount: tax, grossTotal: sub + tax,
    notes:         document.getElementById("templateNotes").value.trim(),
    createdAt:     today(),
  };
  try {
    if (editId) {
      await updateDoc(doc(db, "invoiceTemplates", editId), data);
      const i = cache.templates.findIndex(t => t.id === editId);
      if (i > -1) cache.templates[i] = { id: editId, ...data };
    } else {
      const ref = await addDoc(collection(db, "invoiceTemplates"), data);
      cache.templates.unshift({ id: ref.id, ...data });
    }
    closeModal("templateModal");
    renderTemplatesPage();
    toast(editId ? "Template updated" : "Template saved");
  } catch (err) { toast("Error: " + err.message, "error"); }
}

async function useTemplate(templateId) {
  const t = cache.templates.find(t => t.id === templateId);
  if (!t) return;
  const due = new Date(); due.setDate(due.getDate() + 30);
  const data = {
    invoiceNumber: genNumber("INV", cache.invoices),
    clientId:    t.clientId,
    dateIssued:  today(),
    dueDate:     due.toISOString().split("T")[0],
    taxRate:     t.taxRate,    discount: 0,
    items:       t.items,      subtotal: t.subtotal,
    discountAmount: 0,         taxAmount: t.taxAmount,
    grossTotal:  t.grossTotal, paymentType: t.paymentType,
    notes:       t.notes || `Generated from template: ${t.templateName}`,
    status:      "UNPAID",
  };
  try {
    const ref = await addDoc(collection(db, "invoices"), data);
    cache.invoices.unshift({ id: ref.id, ...data });
    renderInvoicesTable();
    activateAdminPage("invoicesPage", "Invoices");
    toast(`Invoice ${data.invoiceNumber} created from template`);
  } catch (err) { toast("Error: " + err.message, "error"); }
}

function renderTemplatesPage() {
  const grid = document.getElementById("templateGrid");
  if (!cache.templates.length) {
    grid.innerHTML = `<div class="empty-row" style="padding:40px;text-align:center;color:var(--text-3);grid-column:1/-1">
      <i class="fa-solid fa-rectangle-list" style="font-size:28px;margin-bottom:10px;display:block"></i>
      No templates yet. Create one to quickly generate recurring invoices.
    </div>`;
    return;
  }
  grid.innerHTML = cache.templates.map(t => `
    <div class="template-card">
      <div class="template-card-header">
        <div class="template-card-name">${t.templateName}</div>
        <span class="template-card-freq">${t.frequency}</span>
      </div>
      <div class="template-card-meta"><i class="fa-solid fa-building" style="margin-right:5px;color:var(--text-3)"></i>${clientName(t.clientId)}</div>
      <div class="template-card-meta"><i class="fa-solid fa-tag" style="margin-right:5px;color:var(--text-3)"></i>${t.paymentType || "Full Payment"} · ${(t.items||[]).length} line item${(t.items||[]).length!==1?"s":""}</div>
      <div class="template-card-amount">${fmt(t.grossTotal)}</div>
      <div class="template-card-actions">
        <button class="btn-primary btn-sm" style="padding:8px 14px;font-size:13px" data-use-tmpl="${t.id}">
          <i class="fa-solid fa-bolt"></i> Generate Invoice
        </button>
        <button class="btn-icon" title="Edit" data-edit-tmpl="${t.id}"><i class="fa-solid fa-pen"></i></button>
        <button class="btn-icon danger" title="Delete" data-del-tmpl="${t.id}"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>
  `).join("");

  document.querySelectorAll("[data-use-tmpl]").forEach(b  => b.addEventListener("click", () => useTemplate(b.dataset.useTmpl)));
  document.querySelectorAll("[data-edit-tmpl]").forEach(b => b.addEventListener("click", () => openTemplateModal(b.dataset.editTmpl)));
  document.querySelectorAll("[data-del-tmpl]").forEach(b  => b.addEventListener("click", () =>
    confirmAction("Delete this template?", async () => {
      await deleteDoc(doc(db, "invoiceTemplates", b.dataset.delTmpl));
      cache.templates = cache.templates.filter(t => t.id !== b.dataset.delTmpl);
      renderTemplatesPage();
      toast("Template deleted");
    })
  ));
}

// ═══════════════════════════════════════════════════════════
// CLIENT STATEMENT ENGINE
// ═══════════════════════════════════════════════════════════
function openStatementModal(clientId) {
  const c = cache.clients.find(c => c.id === clientId);
  document.getElementById("statementClientId").value      = clientId;
  document.getElementById("statementClientName").value    = c?.companyName || "—";
  // Default: start of current month → today
  const now   = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  document.getElementById("statementFrom").value = first;
  document.getElementById("statementTo").value   = today();
  openModal("statementModal");
}

async function generateStatement(e) {
  e.preventDefault();
  const clientId  = document.getElementById("statementClientId").value;
  const fromDate  = document.getElementById("statementFrom").value;
  const toDate    = document.getElementById("statementTo").value;
  const client    = cache.clients.find(c => c.id === clientId) || {};

  const invs = cache.invoices.filter(i =>
    i.clientId === clientId && i.dateIssued >= fromDate && i.dateIssued <= toDate);
  const recs = cache.receipts.filter(r =>
    r.clientId === clientId && r.dateSettled >= fromDate && r.dateSettled <= toDate);

  const totalInvoiced = invs.reduce((a, i) => a + (i.grossTotal || 0), 0);
  const totalPaid     = recs.reduce((a, r) => a + (r.amountPaid  || 0), 0);
  const balance       = totalInvoiced - totalPaid;

  const { jsPDF } = window.jspdf;
  const d  = new jsPDF();
  const W  = 210, m = 16;

  // Header
  let y = await pdfHeader(d, "STATEMENT", `${fromDate} – ${toDate}`);

  // Client block
  d.setFillColor(235,252,240); d.rect(m, y, W-m*2, 20, "F");
  d.setDrawColor(226,232,240); d.rect(m, y, W-m*2, 20, "S");
  d.setFontSize(8); d.setFont("helvetica","bold"); d.setTextColor(100,116,139);
  d.text("CLIENT", m+5, y+6);
  d.setFont("helvetica","bold"); d.setFontSize(11); d.setTextColor(15,23,42);
  d.text(client.companyName || "—", m+5, y+14);
  if (client.email) { d.setFontSize(8); d.setFont("helvetica","normal"); d.setTextColor(100,116,139); d.text(client.email, m+5, y+19); }
  y += 26;

  // Summary bar
  const summaryItems = [
    ["Total Invoiced", fmt(totalInvoiced)],
    ["Total Paid",     fmt(totalPaid)],
    ["Balance Due",    fmt(balance)],
  ];
  const colW = (W - m*2) / 3;
  d.setFillColor(15,61,46); d.rect(m, y, W-m*2, 18, "F");
  summaryItems.forEach(([label, val], i) => {
    const x = m + i*colW + colW/2;
    d.setFontSize(7); d.setFont("helvetica","normal"); d.setTextColor(180,220,190);
    d.text(label.toUpperCase(), x, y+6, { align: "center" });
    d.setFontSize(10); d.setFont("helvetica","bold"); d.setTextColor(255,255,255);
    d.text(val, x, y+14, { align: "center" });
  });
  y += 24;

  // Invoices table
  d.setFillColor(15,61,46); d.rect(m, y, W-m*2, 8, "F");
  d.setFontSize(8); d.setFont("helvetica","bold"); d.setTextColor(255,255,255);
  d.text("INVOICES", m+4, y+5.5);
  d.text("DATE", 90, y+5.5); d.text("DUE DATE", 120, y+5.5);
  d.text("AMOUNT", 155, y+5.5, { align: "right" }); d.text("STATUS", W-m, y+5.5, { align: "right" });
  y += 9;

  if (invs.length) {
    invs.forEach((inv, i) => {
      if (i%2===0) { d.setFillColor(250,252,250); } else { d.setFillColor(255,255,255); }
      d.rect(m, y, W-m*2, 7.5, "F");
      d.setFontSize(8.5); d.setFont("helvetica","bold"); d.setTextColor(15,23,42);
      d.text(inv.invoiceNumber || "—", m+4, y+5.2);
      d.setFont("helvetica","normal"); d.setTextColor(100,116,139);
      d.text(inv.dateIssued || "—", 90, y+5.2);
      d.text(inv.dueDate    || "—", 120, y+5.2);
      d.setFont("helvetica","bold"); d.setTextColor(15,23,42);
      d.text(pdfFmt(inv.grossTotal), 155, y+5.2, { align: "right" });
      const statusColors = { PAID:[22,163,74], UNPAID:[217,119,6], OVERDUE:[220,38,38] };
      const sc = statusColors[inv.status] || [100,116,139];
      d.setTextColor(...sc); d.text(inv.status || "—", W-m, y+5.2, { align: "right" });
      y += 7.5;
    });
  } else {
    d.setFontSize(8); d.setFont("helvetica","italic"); d.setTextColor(150,150,150);
    d.text("No invoices in this period.", m+4, y+5); y += 10;
  }
  y += 6;

  // Receipts table
  if (y > 240) { d.addPage(); y = 20; }
  d.setFillColor(15,61,46); d.rect(m, y, W-m*2, 8, "F");
  d.setFontSize(8); d.setFont("helvetica","bold"); d.setTextColor(255,255,255);
  d.text("PAYMENTS RECEIVED", m+4, y+5.5);
  d.text("DATE", 90, y+5.5); d.text("METHOD", 120, y+5.5);
  d.text("AMOUNT", W-m, y+5.5, { align: "right" });
  y += 9;

  if (recs.length) {
    recs.forEach((r, i) => {
      if (i%2===0) { d.setFillColor(250,252,250); } else { d.setFillColor(255,255,255); }
      d.rect(m, y, W-m*2, 7.5, "F");
      d.setFontSize(8.5); d.setFont("helvetica","bold"); d.setTextColor(15,23,42);
      d.text(r.receiptNumber || "—", m+4, y+5.2);
      d.setFont("helvetica","normal"); d.setTextColor(100,116,139);
      d.text(r.dateSettled     || "—", 90,   y+5.2);
      d.text(r.paymentMethod   || "—", 120,  y+5.2);
      d.setFont("helvetica","bold"); d.setTextColor(22,163,74);
      d.text(pdfFmt(r.amountPaid), W-m, y+5.2, { align: "right" });
      y += 7.5;
    });
  } else {
    d.setFontSize(8); d.setFont("helvetica","italic"); d.setTextColor(150,150,150);
    d.text("No payments in this period.", m+4, y+5); y += 10;
  }
  y += 6;

  // Balance row
  if (y > 255) { d.addPage(); y = 20; }
  const balColor = balance > 0 ? [220,38,38] : [22,163,74];
  d.setFillColor(...balColor); d.rect(m, y, W-m*2, 12, "F");
  d.setFontSize(9); d.setFont("helvetica","bold"); d.setTextColor(255,255,255);
  d.text("OUTSTANDING BALANCE", m+5, y+8);
  d.setFontSize(11);
  d.text(pdfFmt(balance), W-m, y+8, { align: "right" });
  y += 18;

  pdfFooter(d, y);
  d.save(`Statement_${client.companyName?.replace(/\s+/g,"_") || clientId}_${fromDate}_${toDate}.pdf`);
  closeModal("statementModal");
  toast("Statement downloaded");
}
