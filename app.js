// Lógica do Dashboard de Controle de Estoque Esportivo (EFAF, EM, EFAI e Personalizados)
// Inclui gerenciamento dinâmico de segmentos e armazenamento persistente IndexedDB

const DB_NAME = "EstoqueEsportivoDB_v1";
const STORE_NAME = "inventory_items";
const SEGMENTS_STORAGE_KEY = "EstoqueEsportivo_Segmentos_v1";
const SUPABASE_CONFIG_KEY = "EstoqueEsportivo_SupabaseConfig_v1";

const SUPABASE_ITEMS_TABLE = "estoque_esportivo_itens";
const SUPABASE_CONFIG_TABLE = "estoque_esportivo_config";

let supabaseClient = null;
let realtimeChannel = null;

let state = {
  items: [],
  segmentos: [],
  activeGroup: "todos",         // 'todos' | 'estoque_atual' | 'reposicao_2027'
  activeCategory: "Todas",      // 'Todas' | 'Vôlei' | 'Basquete' | ...
  searchQuery: "",
  segmentFilter: "TODOS",
  conservacaoFilter: "TODOS",
  prioridadeFilter: "TODOS",
  quickCondFilter: null,        // 'ok' | 'medio' | 'pessimo' | 'com_foto'
  viewMode: "cards",            // 'cards' | 'table'
  currentPhotoItemId: null,
  cloudConnected: false
};

// ============================================================================
// CAMADA DE NUVEM ONLINE (SUPABASE REALTIME + POSTGRESQL)
// ============================================================================
function getSavedSupabaseCredentials() {
  try {
    const raw = localStorage.getItem(SUPABASE_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function updateCloudStatusUI(status, message) {
  const dot = document.getElementById("cloudStatusDot");
  const text = document.getElementById("cloudStatusText");
  const banner = document.getElementById("supabaseModalStatusBanner");

  if (!dot || !text) return;

  dot.className = "status-dot";
  if (status === "online") {
    dot.classList.add("dot-online");
    text.textContent = "☁️ Online (Supabase)";
    state.cloudConnected = true;
    if (banner) {
      banner.innerHTML = `Status: <strong style="color:#10b981;">🟢 Conectado ao Supabase Cloud</strong> — ${message || "Sincronização online ativa em tempo real."}`;
    }
  } else if (status === "syncing") {
    dot.classList.add("dot-syncing");
    text.textContent = "☁️ Sincronizando...";
    if (banner && message) {
      banner.innerHTML = `Status: <strong style="color:#f59e0b;">⏳ Sincronizando...</strong> — ${message}`;
    }
  } else {
    dot.classList.add("dot-offline");
    text.textContent = "☁️ Conectar Supabase";
    state.cloudConnected = false;
    if (banner) {
      banner.innerHTML = `Status: <strong>Modo Local (Offline)</strong> — ${message || "Insira a Project URL e API Key do seu projeto Supabase abaixo."}`;
    }
  }
}

async function initSupabaseConnection(url, key, autoSync = true) {
  if (!url || !key || !window.supabase) {
    updateCloudStatusUI("offline");
    return false;
  }

  try {
    updateCloudStatusUI("syncing", "Conectando ao banco de dados Supabase...");
    supabaseClient = window.supabase.createClient(url.trim(), key.trim());

    // Testa leitura da tabela de itens
    const { data: cloudItems, error: itemsError } = await supabaseClient
      .from(SUPABASE_ITEMS_TABLE)
      .select("*");

    if (itemsError) {
      console.error("Erro Supabase:", itemsError);
      updateCloudStatusUI(
        "offline",
        `Erro ao acessar tabela (${itemsError.message}). Certifique-se de executar o comando SQL no Supabase!`
      );
      return false;
    }

    // Busca segmentos salvos na nuvem
    const { data: segRow } = await supabaseClient
      .from(SUPABASE_CONFIG_TABLE)
      .select("value")
      .eq("key", "segmentos")
      .maybeSingle();

    if (autoSync) {
      if (cloudItems && cloudItems.length > 0) {
        // Nuvem já tem dados -> atualiza local com dados da nuvem
        state.items = cloudItems;
        await saveAllItemsToLocalOnly(state.items);
      } else if (state.items.length > 0) {
        // Nuvem está vazia -> sobe dados locais automaticamente para a nuvem
        await supabaseClient.from(SUPABASE_ITEMS_TABLE).upsert(state.items);
      }

      if (segRow && Array.isArray(segRow.value) && segRow.value.length > 0) {
        state.segmentos = segRow.value;
        localStorage.setItem(SEGMENTS_STORAGE_KEY, JSON.stringify(state.segmentos));
      } else {
        await supabaseClient.from(SUPABASE_CONFIG_TABLE).upsert({
          key: "segmentos",
          value: state.segmentos,
          updated_at: new Date().toISOString()
        });
      }
    }

    // Assina mudanças em tempo real (Realtime)
    subscribeToRealtimeChanges();

    updateCloudStatusUI("online", `Sincronizado (${state.items.length} itens na nuvem).`);
    renderAll();
    return true;
  } catch (err) {
    console.error("Falha ao conectar Supabase:", err);
    updateCloudStatusUI("offline", "Não foi possível conectar. Verifique a URL e a Anon Key.");
    return false;
  }
}

function subscribeToRealtimeChanges() {
  if (!supabaseClient) return;
  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
  }

  realtimeChannel = supabaseClient
    .channel("estoque-realtime-channel")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: SUPABASE_ITEMS_TABLE },
      async () => {
        const { data } = await supabaseClient.from(SUPABASE_ITEMS_TABLE).select("*");
        if (data) {
          state.items = data;
          await saveAllItemsToLocalOnly(state.items);
          renderAll();
        }
      }
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: SUPABASE_CONFIG_TABLE },
      async () => {
        const { data } = await supabaseClient
          .from(SUPABASE_CONFIG_TABLE)
          .select("value")
          .eq("key", "segmentos")
          .maybeSingle();
        if (data && Array.isArray(data.value)) {
          state.segmentos = data.value;
          localStorage.setItem(SEGMENTS_STORAGE_KEY, JSON.stringify(state.segmentos));
          renderAll();
        }
      }
    )
    .subscribe();
}

// ============================================================================
// CAMADA DE BANCO DE DADOS LOCAL (IndexedDB com suporte a segmentos dinâmicos)
// ============================================================================
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function loadDataFromDB() {
  const savedSegs = localStorage.getItem(SEGMENTS_STORAGE_KEY);
  let segmentos = null;
  try {
    segmentos = savedSegs ? JSON.parse(savedSegs) : null;
  } catch (e) {
    segmentos = null;
  }

  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const storeItems = tx.objectStore(STORE_NAME);
      const reqItems = storeItems.getAll();
      reqItems.onsuccess = () => {
        resolve({
          items: reqItems.result || [],
          segmentos
        });
      };
      reqItems.onerror = () => reject(reqItems.error);
    });
  } catch (err) {
    console.warn("Fallback para LocalStorage:", err);
    const savedItems = localStorage.getItem(DB_NAME);
    return {
      items: savedItems ? JSON.parse(savedItems) : [],
      segmentos
    };
  }
}

async function saveAllItemsToLocalOnly(items) {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      items.forEach((item) => store.put(item));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    localStorage.setItem(DB_NAME, JSON.stringify(items));
  }
}

async function saveAllItemsToDB(items) {
  await saveAllItemsToLocalOnly(items);

  if (supabaseClient && state.cloudConnected) {
    try {
      updateCloudStatusUI("syncing", "Salvando todos os itens na nuvem...");
      await supabaseClient.from(SUPABASE_ITEMS_TABLE).upsert(items);
      updateCloudStatusUI("online", "Todos os itens sincronizados.");
    } catch (e) {
      console.error("Erro ao sincronizar lote com Supabase:", e);
    }
  }
}

async function saveSegmentsToDB(segments) {
  localStorage.setItem(SEGMENTS_STORAGE_KEY, JSON.stringify(segments));

  if (supabaseClient && state.cloudConnected) {
    try {
      await supabaseClient.from(SUPABASE_CONFIG_TABLE).upsert({
        key: "segmentos",
        value: segments,
        updated_at: new Date().toISOString()
      });
    } catch (e) {
      console.error("Erro ao salvar segmentos no Supabase:", e);
    }
  }
}

async function saveSingleItemToDB(item) {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    localStorage.setItem(DB_NAME + "_items", JSON.stringify(state.items));
  }

  if (supabaseClient && state.cloudConnected) {
    try {
      updateCloudStatusUI("syncing", "Salvando alteração na nuvem...");
      await supabaseClient.from(SUPABASE_ITEMS_TABLE).upsert(item);
      updateCloudStatusUI("online", `Item "${item.item}" salvo na nuvem.`);
    } catch (e) {
      console.error("Erro ao salvar item no Supabase:", e);
    }
  }
}

async function deleteItemFromDB(id) {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    localStorage.setItem(DB_NAME + "_items", JSON.stringify(state.items));
  }

  if (supabaseClient && state.cloudConnected) {
    try {
      await supabaseClient.from(SUPABASE_ITEMS_TABLE).delete().eq("id", id);
    } catch (e) {
      console.error("Erro ao excluir item no Supabase:", e);
    }
  }
}

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  const data = await loadDataFromDB();
  
  if (data.items && data.items.length > 0) {
    state.items = data.items;
  } else {
    state.items = JSON.parse(JSON.stringify(INITIAL_INVENTORY_DATA));
    await saveAllItemsToLocalOnly(state.items);
  }

  if (data.segmentos && Array.isArray(data.segmentos) && data.segmentos.length > 0) {
    state.segmentos = data.segmentos;
  } else {
    state.segmentos = [...INITIAL_SEGMENTOS];
    // Coleta qualquer outro segmento presente nos itens
    state.items.forEach(i => {
      if (i.segmento && !state.segmentos.includes(i.segmento)) {
        state.segmentos.push(i.segmento);
      }
    });
    localStorage.setItem(SEGMENTS_STORAGE_KEY, JSON.stringify(state.segmentos));
  }

  bindEvents();
  renderAll();

  // Tenta reconectar automaticamente ao Supabase se já houver credenciais salvas
  const creds = getSavedSupabaseCredentials();
  if (creds && creds.url && creds.key) {
    document.getElementById("inputSupabaseUrl").value = creds.url;
    document.getElementById("inputSupabaseKey").value = creds.key;
    await initSupabaseConnection(creds.url, creds.key, true);
  }
});

// ============================================================================
// GESTÃO DE SEGMENTOS (CRIAR, EDITAR / MUDAR, EXCLUIR)
// ============================================================================
function renderSegmentSelectOptions(selectedVal = null) {
  const selectFilter = document.getElementById("filterSegmento");
  const selectForm = document.getElementById("formSegmento");

  // Salva seleção atual
  const currentFilterVal = selectedVal || selectFilter.value || "TODOS";
  const currentFormVal = selectForm.value || (state.segmentos[0] || "");

  // Popula Filtro de busca
  selectFilter.innerHTML = `
    <option value="TODOS">Todos os Segmentos</option>
    ${state.segmentos.map(seg => `<option value="${seg}">${seg}</option>`).join("")}
  `;
  selectFilter.value = state.segmentos.includes(currentFilterVal) ? currentFilterVal : "TODOS";

  // Popula Formulário de Cadastro
  selectForm.innerHTML = state.segmentos
    .map(seg => `<option value="${seg}">${seg}</option>`)
    .join("");
  if (state.segmentos.includes(currentFormVal)) {
    selectForm.value = currentFormVal;
  }

  // Popula Chips da Sidebar
  renderSidebarSegmentChips();
}

function renderSidebarSegmentChips() {
  const container = document.getElementById("sidebarSegmentList");
  if (!container) return;

  const isAll = state.segmentFilter === "TODOS";
  let html = `
    <button class="seg-chip ${isAll ? "active" : ""}" data-seg="TODOS">
      Todos
    </button>
  `;

  state.segmentos.forEach(seg => {
    const isActive = state.segmentFilter === seg;
    const count = state.items.filter(i => i.segmento === seg).length;
    html += `
      <button class="seg-chip ${isActive ? "active" : ""}" data-seg="${seg}">
        ${seg} (${count})
      </button>
    `;
  });

  container.innerHTML = html;

  container.querySelectorAll(".seg-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      state.segmentFilter = chip.dataset.seg;
      document.getElementById("filterSegmento").value = state.segmentFilter;
      renderAll();
    });
  });
}

function openSegmentManagerModal() {
  renderSegmentManagerList();
  document.getElementById("segmentModal").classList.remove("hidden");
  document.getElementById("newSegmentInput").focus();
}

function renderSegmentManagerList() {
  const list = document.getElementById("segmentManageList");
  if (state.segmentos.length === 0) {
    list.innerHTML = `<p style="color:var(--text-muted); font-size:0.85rem;">Nenhum segmento cadastrado.</p>`;
    return;
  }

  list.innerHTML = state.segmentos.map((seg, idx) => {
    const count = state.items.filter(i => i.segmento === seg).length;
    return `
      <div class="segment-manage-item" data-index="${idx}">
        <div class="segment-name-wrap" id="seg-view-${idx}">
          <strong>🏷️ ${seg}</strong>
          <span style="font-size:0.75rem; color:var(--text-muted);">(${count} item(ns) associado(s))</span>
        </div>
        <div class="segment-name-wrap hidden" id="seg-edit-${idx}">
          <input type="text" class="segment-edit-input" id="seg-input-${idx}" value="${seg}" />
          <button class="btn btn-primary js-save-rename-seg" data-index="${idx}" style="padding:0.3rem 0.6rem; font-size:0.75rem;">Salvar</button>
          <button class="btn btn-ghost js-cancel-rename-seg" data-index="${idx}" style="padding:0.3rem 0.5rem; font-size:0.75rem;">✕</button>
        </div>
        <div class="segment-actions" id="seg-actions-${idx}">
          <button class="btn btn-outline js-start-rename-seg" data-index="${idx}" style="padding:0.3rem 0.6rem; font-size:0.75rem;" title="Mudar / Renomear Segmento">✏️ Renomear</button>
          <button class="btn btn-danger js-delete-seg" data-index="${idx}" style="padding:0.3rem 0.6rem; font-size:0.75rem;" title="Excluir Segmento">🗑️</button>
        </div>
      </div>
    `;
  }).join("");

  // Eventos de renomear
  list.querySelectorAll(".js-start-rename-seg").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = btn.dataset.index;
      document.getElementById(`seg-view-${idx}`).classList.add("hidden");
      document.getElementById(`seg-actions-${idx}`).classList.add("hidden");
      document.getElementById(`seg-edit-${idx}`).classList.remove("hidden");
      const inp = document.getElementById(`seg-input-${idx}`);
      inp.focus();
      inp.select();
    });
  });

  list.querySelectorAll(".js-cancel-rename-seg").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = btn.dataset.index;
      document.getElementById(`seg-view-${idx}`).classList.remove("hidden");
      document.getElementById(`seg-actions-${idx}`).classList.remove("hidden");
      document.getElementById(`seg-edit-${idx}`).classList.add("hidden");
    });
  });

  list.querySelectorAll(".js-save-rename-seg").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const oldName = state.segmentos[idx];
      const newName = document.getElementById(`seg-input-${idx}`).value.trim();

      if (!newName) {
        alert("O nome do segmento não pode ficar em branco.");
        return;
      }

      if (newName !== oldName) {
        if (state.segmentos.includes(newName)) {
          alert("Já existe um segmento com esse nome.");
          return;
        }

        // Atualiza a lista de segmentos
        state.segmentos[idx] = newName;
        await saveSegmentsToDB(state.segmentos);

        // Atualiza todos os itens que utilizavam o segmento antigo
        let updatedCount = 0;
        state.items.forEach(item => {
          if (item.segmento === oldName) {
            item.segmento = newName;
            updatedCount++;
          }
        });

        if (updatedCount > 0) {
          await saveAllItemsToDB(state.items);
        }

        if (state.segmentFilter === oldName) {
          state.segmentFilter = newName;
        }
      }

      renderSegmentManagerList();
      renderAll();
    });
  });

  // Evento de excluir
  list.querySelectorAll(".js-delete-seg").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const segName = state.segmentos[idx];
      const associatedItems = state.items.filter(i => i.segmento === segName).length;

      let msg = `Deseja realmente remover o segmento "${segName}"?`;
      if (associatedItems > 0) {
        msg += `\n\nAtenção: Existem ${associatedItems} item(ns) vinculados a ele. O segmento desses itens será alterado para "Geral".`;
      }

      if (confirm(msg)) {
        state.segmentos.splice(idx, 1);
        if (!state.segmentos.includes("Geral") && associatedItems > 0) {
          state.segmentos.push("Geral");
        }
        await saveSegmentsToDB(state.segmentos);

        if (associatedItems > 0) {
          state.items.forEach(item => {
            if (item.segmento === segName) {
              item.segmento = "Geral";
            }
          });
          await saveAllItemsToDB(state.items);
        }

        if (state.segmentFilter === segName) {
          state.segmentFilter = "TODOS";
        }

        renderSegmentManagerList();
        renderAll();
      }
    });
  });
}

async function handleAddNewSegment() {
  const input = document.getElementById("newSegmentInput");
  const val = input.value.trim();
  if (!val) {
    alert("Digite o nome do novo segmento.");
    return;
  }
  if (state.segmentos.includes(val)) {
    alert("Este segmento já existe.");
    return;
  }

  state.segmentos.push(val);
  await saveSegmentsToDB(state.segmentos);
  input.value = "";
  renderSegmentManagerList();
  renderAll();
}

// ============================================================================
// UTILITÁRIOS DE FORMATAÇÃO E CLASSIFICAÇÃO
// ============================================================================
function getConditionBadgeClass(conservacao) {
  const c = (conservacao || "").toLowerCase();
  if (c === "novo") return "cond-novo";
  if (c === "bom") return "cond-bom";
  if (c === "bom/médio" || c === "bom/medio") return "cond-bom-medio";
  if (c === "médio" || c === "medio") return "cond-medio";
  if (c === "médio/péssimo" || c === "medio/pessimo") return "cond-medio-pessimo";
  if (c === "péssimo" || c === "pessimo") return "cond-pessimo";
  return "cond-nd";
}

function getConditionEmoji(conservacao) {
  const c = (conservacao || "").toLowerCase();
  if (c === "novo" || c === "bom") return "🟢";
  if (c === "bom/médio" || c === "bom/medio" || c === "médio" || c === "medio") return "🟡";
  if (c === "médio/péssimo" || c === "medio/pessimo") return "🟠";
  if (c === "péssimo" || c === "pessimo") return "🔴";
  return "⚪";
}

function getPriorityClass(prio) {
  const p = (prio || "").toLowerCase();
  if (p === "alta") return "prio-alta";
  if (p === "média" || p === "media" || p === "atenção") return "prio-media";
  return "prio-normal";
}

function parseNumericQuantity(qntStr) {
  if (!qntStr) return 0;
  const match = String(qntStr).match(/^\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

// Comprime imagem via Canvas para carregamento ultra-rápido e leve
function compressImageFile(file, maxWidth = 1100, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve({
          id: "img-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7),
          dataUrl,
          date: new Date().toLocaleDateString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          }),
          name: file.name
        });
      };
      img.onerror = reject;
      img.src = event.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ============================================================================
// FILTRAGEM DE DADOS
// ============================================================================
function getBaseGroupFilteredItems() {
  return state.items.filter((item) => {
    if (state.activeGroup !== "todos" && item.group !== state.activeGroup) {
      return false;
    }
    return true;
  });
}

function getFilteredItems() {
  return state.items.filter((item) => {
    // 1. Filtro de Grupo (Estoque Atual vs Reposição 2027)
    if (state.activeGroup !== "todos" && item.group !== state.activeGroup) {
      return false;
    }

    // 2. Filtro de Categoria
    if (state.activeCategory !== "Todas" && item.categoria !== state.activeCategory) {
      return false;
    }

    // 3. Filtro de Segmento (dinâmico)
    if (state.segmentFilter !== "TODOS" && item.segmento !== state.segmentFilter) {
      return false;
    }

    // 4. Filtro de Conservação (Select)
    if (state.conservacaoFilter !== "TODOS") {
      if ((item.conservacao || "").toLowerCase() !== state.conservacaoFilter.toLowerCase()) {
        return false;
      }
    }

    // 5. Filtro de Prioridade
    if (state.prioridadeFilter !== "TODOS") {
      if ((item.prioridade || "").toLowerCase() !== state.prioridadeFilter.toLowerCase()) {
        return false;
      }
    }

    // 6. Filtro Rápido clicando nos Cards KPI
    if (state.quickCondFilter) {
      const c = (item.conservacao || "").toLowerCase();
      if (state.quickCondFilter === "ok" && !(c === "novo" || c === "bom")) return false;
      if (state.quickCondFilter === "medio" && !(c === "bom/médio" || c === "bom/medio" || c === "médio" || c === "medio")) return false;
      if (state.quickCondFilter === "pessimo" && !(c === "médio/péssimo" || c === "medio/pessimo" || c === "péssimo" || c === "pessimo")) return false;
      if (state.quickCondFilter === "com_foto" && (!item.imagens || item.imagens.length === 0)) return false;
    }

    // 7. Busca textual
    if (state.searchQuery.trim() !== "") {
      const q = state.searchQuery.toLowerCase();
      const target = `${item.item} ${item.marcaModelo} ${item.categoria} ${item.local} ${item.segmento} ${item.observacoes} ${item.conservacao}`.toLowerCase();
      if (!target.includes(q)) return false;
    }

    return true;
  });
}

// ============================================================================
// RENDERIZAÇÃO COMPLETA
// ============================================================================
function renderAll() {
  renderSegmentSelectOptions();
  renderGroupCounts();
  renderSidebarCategories();
  renderCategoryStrip();
  renderHeaderTitle();
  renderKPIs();
  renderItemsList();
}

function renderGroupCounts() {
  document.getElementById("count-group-todos").textContent = state.items.length;
  document.getElementById("count-group-estoque").textContent = state.items.filter(i => i.group === "estoque_atual").length;
  document.getElementById("count-group-reposicao").textContent = state.items.filter(i => i.group === "reposicao_2027").length;

  document.querySelectorAll(".group-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.group === state.activeGroup);
  });
}

function renderSidebarCategories() {
  const nav = document.getElementById("categoryNav");
  const baseItems = getBaseGroupFilteredItems();

  const categories = Object.keys(CATEGORY_METADATA);
  nav.innerHTML = categories
    .map((cat) => {
      const meta = CATEGORY_METADATA[cat];
      const count =
        cat === "Todas"
          ? baseItems.length
          : baseItems.filter((i) => i.categoria === cat).length;

      const isActive = state.activeCategory === cat ? "active" : "";
      return `
        <button class="cat-btn ${isActive}" data-category="${cat}">
          <span class="cat-btn-left">
            <span>${meta.icon}</span>
            <span>${meta.label}</span>
          </span>
          <span class="badge-count">${count}</span>
        </button>
      `;
    })
    .join("");

  nav.querySelectorAll(".cat-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeCategory = btn.dataset.category;
      renderAll();
    });
  });
}

function renderCategoryStrip() {
  const strip = document.getElementById("categorySummaryStrip");
  const baseItems = getBaseGroupFilteredItems();
  const categories = Object.keys(CATEGORY_METADATA);

  strip.innerHTML = categories
    .map((cat) => {
      const meta = CATEGORY_METADATA[cat];
      const count =
        cat === "Todas"
          ? baseItems.length
          : baseItems.filter((i) => i.categoria === cat).length;
      const isActive = state.activeCategory === cat ? "active" : "";
      return `
        <button class="cat-pill ${isActive}" data-category="${cat}">
          <span>${meta.icon}</span>
          <span>${cat}</span>
          <span>(${count})</span>
        </button>
      `;
    })
    .join("");

  strip.querySelectorAll(".cat-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      state.activeCategory = pill.dataset.category;
      renderAll();
    });
  });
}

function renderHeaderTitle() {
  const meta = CATEGORY_METADATA[state.activeCategory] || CATEGORY_METADATA["Todas"];
  const segSuffix = state.segmentFilter !== "TODOS" ? ` • Segmento: ${state.segmentFilter}` : "";
  const groupLabels = {
    todos: `Estoque Atual + Reposição 2027${segSuffix}`,
    estoque_atual: `Estoque Atual (Gaiolas • Bolsas • Armazéns)${segSuffix}`,
    reposicao_2027: `Planejamento de Compras & Reposição 2027${segSuffix}`
  };

  document.getElementById("currentViewTitle").textContent = `${meta.icon} ${meta.label}`;
  document.getElementById("currentViewSubtitle").textContent = groupLabels[state.activeGroup];
}

function renderKPIs() {
  const filtered = getFilteredItems();
  const totalUnits = filtered.reduce((acc, item) => acc + parseNumericQuantity(item.quantidade), 0);

  const bomCount = filtered.filter((i) => {
    const c = (i.conservacao || "").toLowerCase();
    return c === "novo" || c === "bom";
  }).length;

  const medioCount = filtered.filter((i) => {
    const c = (i.conservacao || "").toLowerCase();
    return c === "bom/médio" || c === "bom/medio" || c === "médio" || c === "medio";
  }).length;

  const pessimoCount = filtered.filter((i) => {
    const c = (i.conservacao || "").toLowerCase();
    return c === "médio/péssimo" || c === "medio/pessimo" || c === "péssimo" || c === "pessimo";
  }).length;

  const comFotoCount = filtered.filter((i) => i.imagens && i.imagens.length > 0).length;

  document.getElementById("kpiTotalRegistros").textContent = filtered.length;
  document.getElementById("kpiTotalUnidades").textContent = `${totalUnits} unidades somadas`;
  document.getElementById("kpiBomEstado").textContent = bomCount;
  document.getElementById("kpiMedioEstado").textContent = medioCount;
  document.getElementById("kpiPessimoEstado").textContent = pessimoCount;
  document.getElementById("kpiComFoto").textContent = comFotoCount;
}

function renderItemsList() {
  const container = document.getElementById("itemsContainer");
  const filtered = getFilteredItems();

  if (filtered.length === 0) {
    container.className = "items-grid";
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align:center; padding: 3.5rem; background: var(--bg-card); border-radius: 16px; border: 1px dashed var(--border-color);">
        <div style="font-size: 3rem; margin-bottom: 0.75rem;">🔍</div>
        <h3>Nenhum item encontrado para estes filtros</h3>
        <p style="color: var(--text-muted); margin: 0.5rem 0 1.25rem;">Tente limpar a busca ou selecionar "Todos os Segmentos".</p>
        <button class="btn btn-primary" id="btnResetFilters">Limpar Filtros</button>
      </div>
    `;
    const resetBtn = document.getElementById("btnResetFilters");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        state.activeCategory = "Todas";
        state.searchQuery = "";
        state.segmentFilter = "TODOS";
        state.conservacaoFilter = "TODOS";
        state.prioridadeFilter = "TODOS";
        state.quickCondFilter = null;
        document.getElementById("searchInput").value = "";
        document.getElementById("filterSegmento").value = "TODOS";
        document.getElementById("filterConservacao").value = "TODOS";
        document.getElementById("filterPrioridade").value = "TODOS";
        renderAll();
      });
    }
    return;
  }

  if (state.viewMode === "cards") {
    container.className = "items-grid";
    container.innerHTML = filtered.map((item) => renderItemCard(item)).join("");
  } else {
    container.className = "table-wrapper";
    container.innerHTML = renderItemsTable(filtered);
  }

  bindItemActionListeners();
}

function renderItemCard(item) {
  const catMeta = CATEGORY_METADATA[item.categoria] || { icon: "📦" };
  const condClass = getConditionBadgeClass(item.conservacao);
  const condEmoji = getConditionEmoji(item.conservacao);
  const prioClass = getPriorityClass(item.prioridade);
  const hasPhotos = item.imagens && item.imagens.length > 0;
  const coverPhoto = hasPhotos ? item.imagens[0].dataUrl : null;

  const isDangerObs =
    item.observacoes &&
    (item.observacoes.toLowerCase().includes("furad") ||
      item.observacoes.toLowerCase().includes("péssim") ||
      item.observacoes.toLowerCase().includes("rasgad") ||
      item.observacoes.toLowerCase().includes("gasta") ||
      item.observacoes.toLowerCase().includes("sem condições"));

  return `
    <article class="item-card" data-id="${item.id}">
      <div class="card-image-area">
        ${
          coverPhoto
            ? `<img src="${coverPhoto}" alt="${item.item}" class="js-zoom-photo" data-id="${item.id}" />`
            : `
          <div class="card-no-photo js-open-photo-modal" data-id="${item.id}">
            <div class="no-photo-sport-icon">${catMeta.icon}</div>
            <span class="no-photo-cta">📷 Inserir foto da condição</span>
          </div>
        `
        }

        <div class="card-top-badges">
          <span class="badge badge-segment">${item.segmento} • ${item.local}</span>
          <span class="badge ${condClass}">${condEmoji} ${item.conservacao}</span>
        </div>

        <button class="photo-counter-chip js-open-photo-modal" data-id="${item.id}" title="Adicionar ou ver fotos da condição">
          📸 ${hasPhotos ? `${item.imagens.length} foto(s)` : "Anexar Foto"}
        </button>
      </div>

      <div class="card-body">
        <div class="card-cat-row">
          <span>${catMeta.icon} ${item.categoria}</span>
          <span class="priority-tag ${prioClass}">
            ${item.prioridade === "Alta" ? "🔥 Prioridade Alta" : item.prioridade === "Média" ? "⚡ Prioridade Média" : "📋 Normal"}
          </span>
        </div>

        <div>
          <h3 class="card-title">${item.item}</h3>
          <p class="card-brand">Marca/Modelo: <strong>${item.marcaModelo || "Não informado"}</strong></p>
        </div>

        <div class="card-metrics">
          <div class="metric-box">
            <span class="metric-label">Quantidade</span>
            <span class="metric-val">${item.quantidade}</span>
          </div>
          <div class="metric-box">
            <span class="metric-label">Qnt. Mínima</span>
            <span class="metric-val">${item.qntMinima || "-"}</span>
          </div>
          <div class="metric-box">
            <span class="metric-label">No Colégio?</span>
            <span class="metric-val">${item.temNoColegio || "Sim"}</span>
          </div>
        </div>

        ${
          item.observacoes
            ? `<div class="card-obs ${isDangerObs ? "obs-danger" : ""}">
                <strong>Obs:</strong> ${item.observacoes}
              </div>`
            : ""
        }

        <div class="card-actions">
          <button class="btn btn-secondary js-open-photo-modal" data-id="${item.id}">
            📷 Fotos Condição (${hasPhotos ? item.imagens.length : 0})
          </button>
          <button class="btn btn-outline js-edit-item" data-id="${item.id}">
            ✏️ Editar
          </button>
          ${
            item.linkReferencia
              ? `<a href="${item.linkReferencia}" target="_blank" rel="noopener noreferrer" class="btn btn-primary" title="Abrir link de compra/referência">
                  🛒 Link Compra
                </a>`
              : ""
          }
        </div>
      </div>
    </article>
  `;
}

function renderItemsTable(items) {
  return `
    <table class="inventory-table">
      <thead>
        <tr>
          <th>Foto Condição</th>
          <th>Segmento / Local</th>
          <th>Categoria</th>
          <th>Item & Marca/Modelo</th>
          <th>Qnt.</th>
          <th>Mín.</th>
          <th>Conservação</th>
          <th>Observações</th>
          <th>Ações</th>
        </tr>
      </thead>
      <tbody>
        ${items
          .map((item) => {
            const catMeta = CATEGORY_METADATA[item.categoria] || { icon: "📦" };
            const condClass = getConditionBadgeClass(item.conservacao);
            const condEmoji = getConditionEmoji(item.conservacao);
            const hasPhotos = item.imagens && item.imagens.length > 0;
            return `
              <tr>
                <td>
                  ${
                    hasPhotos
                      ? `<img src="${item.imagens[0].dataUrl}" class="table-thumb js-open-photo-modal" data-id="${item.id}" title="Ver ${item.imagens.length} foto(s)" />`
                      : `<button class="btn btn-outline js-open-photo-modal" data-id="${item.id}" style="padding:0.35rem 0.6rem; font-size:0.75rem;">📷 +Foto</button>`
                  }
                </td>
                <td>
                  <strong>${item.segmento}</strong><br/>
                  <span style="color:var(--text-muted); font-size:0.78rem;">${item.local}</span>
                </td>
                <td>${catMeta.icon} ${item.categoria}</td>
                <td>
                  <strong>${item.item}</strong><br/>
                  <span style="color:var(--text-muted); font-size:0.78rem;">${item.marcaModelo || "-"}</span>
                </td>
                <td><strong>${item.quantidade}</strong></td>
                <td>${item.qntMinima || "-"}</td>
                <td><span class="badge ${condClass}">${condEmoji} ${item.conservacao}</span></td>
                <td style="max-width: 240px; font-size:0.8rem; color:var(--text-muted);">${item.observacoes || "-"}</td>
                <td>
                  <div style="display:flex; gap:0.4rem;">
                    <button class="btn btn-secondary js-open-photo-modal" data-id="${item.id}" style="padding:0.35rem 0.6rem;">📸</button>
                    <button class="btn btn-outline js-edit-item" data-id="${item.id}" style="padding:0.35rem 0.6rem;">✏️</button>
                    ${
                      item.linkReferencia
                        ? `<a href="${item.linkReferencia}" target="_blank" rel="noopener noreferrer" class="btn btn-primary" style="padding:0.35rem 0.6rem;">🛒</a>`
                        : ""
                    }
                  </div>
                </td>
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

// ============================================================================
// GERENCIAMENTO DO MODAL DE FOTOS DE CONDIÇÃO DO ITEM
// ============================================================================
function openPhotoModal(itemId) {
  const item = state.items.find((i) => i.id === itemId);
  if (!item) return;

  state.currentPhotoItemId = itemId;
  document.getElementById("photoModalTitle").textContent = `📸 Condição do Item: ${item.item}`;
  document.getElementById("photoModalSubtitle").textContent = `${item.segmento} (${item.local}) • Marca/Modelo: ${item.marcaModelo || "N/A"} • Quantidade: ${item.quantidade}`;
  document.getElementById("modalQuickConservacao").value = item.conservacao || "Bom";
  document.getElementById("modalQuickObs").value = item.observacoes || "";

  renderModalPhotoGallery(item);
  document.getElementById("photoModal").classList.remove("hidden");
}

function renderModalPhotoGallery(item) {
  const gallery = document.getElementById("photoGalleryGrid");
  const countLabel = document.getElementById("photoCountLabel");
  const photos = item.imagens || [];
  countLabel.textContent = photos.length;

  if (photos.length === 0) {
    gallery.innerHTML = `
      <div style="grid-column: 1/-1; color: var(--text-muted); font-size: 0.85rem; padding: 1rem; text-align: center; background: rgba(15,23,42,0.4); border-radius: 10px;">
        Nenhuma foto anexada ainda. Selecione ou arraste uma imagem acima para ilustrar a condição deste material.
      </div>
    `;
    return;
  }

  gallery.innerHTML = photos
    .map(
      (photo, idx) => `
      <div class="photo-item-card">
        <img src="${photo.dataUrl}" alt="Foto ${idx + 1}" class="js-lightbox-img" data-url="${photo.dataUrl}" data-caption="${item.item} - ${item.conservacao} (${photo.date})" />
        <div class="photo-item-footer">
          <span>📅 ${photo.date || "Registrada"}</span>
          <button class="btn btn-danger js-delete-photo" data-photo-id="${photo.id}" style="padding: 0.2rem 0.45rem; font-size: 0.72rem;">
            🗑️
          </button>
        </div>
      </div>
    `
    )
    .join("");

  gallery.querySelectorAll(".js-lightbox-img").forEach((img) => {
    img.addEventListener("click", () => {
      openLightbox(img.dataset.url, img.dataset.caption);
    });
  });

  gallery.querySelectorAll(".js-delete-photo").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const photoId = btn.dataset.photoId;
      item.imagens = item.imagens.filter((p) => p.id !== photoId);
      await saveSingleItemToDB(item);
      renderModalPhotoGallery(item);
      renderAll();
    });
  });
}

async function handleFilesUpload(fileList) {
  if (!state.currentPhotoItemId || !fileList || fileList.length === 0) return;
  const item = state.items.find((i) => i.id === state.currentPhotoItemId);
  if (!item) return;

  if (!item.imagens) item.imagens = [];

  for (const file of Array.from(fileList)) {
    if (!file.type.startsWith("image/")) continue;
    const compressed = await compressImageFile(file);
    item.imagens.unshift(compressed);
  }

  await saveSingleItemToDB(item);
  renderModalPhotoGallery(item);
  renderAll();
}

// ============================================================================
// GERENCIAMENTO DO MODAL DE CRIAR / EDITAR ITEM
// ============================================================================
function openItemModal(itemId = null) {
  const form = document.getElementById("itemForm");
  const deleteBtn = document.getElementById("btnDeleteItem");

  // Garante que o select de segmento tem todas as opções
  renderSegmentSelectOptions();

  if (itemId) {
    const item = state.items.find((i) => i.id === itemId);
    if (!item) return;

    document.getElementById("itemModalTitle").textContent = "✏️ Editar Item";
    document.getElementById("formItemId").value = item.id;
    document.getElementById("formGroup").value = item.group || "estoque_atual";
    document.getElementById("formCategoria").value = item.categoria || "Vôlei";
    document.getElementById("formSegmento").value = item.segmento || state.segmentos[0];
    document.getElementById("formLocal").value = item.local || "";
    document.getElementById("formItemName").value = item.item || "";
    document.getElementById("formMarcaModelo").value = item.marcaModelo || "";
    document.getElementById("formQuantidade").value = item.quantidade || "";
    document.getElementById("formQntMinima").value = item.qntMinima || "";
    document.getElementById("formConservacao").value = item.conservacao || "Bom";
    document.getElementById("formPrioridade").value = item.prioridade || "Normal";
    document.getElementById("formTemNoColegio").value = item.temNoColegio || "Sim";
    document.getElementById("formObservacoes").value = item.observacoes || "";
    document.getElementById("formLink").value = item.linkReferencia || "";
    deleteBtn.classList.remove("hidden");
  } else {
    form.reset();
    document.getElementById("itemModalTitle").textContent = "➕ Adicionar Novo Item ao Estoque";
    document.getElementById("formItemId").value = "";
    if (state.activeCategory !== "Todas") {
      document.getElementById("formCategoria").value = state.activeCategory;
    }
    if (state.activeGroup !== "todos") {
      document.getElementById("formGroup").value = state.activeGroup;
    }
    if (state.segmentFilter !== "TODOS") {
      document.getElementById("formSegmento").value = state.segmentFilter;
    } else {
      document.getElementById("formSegmento").value = state.segmentos[0] || "";
    }
    deleteBtn.classList.add("hidden");
  }

  document.getElementById("itemModal").classList.remove("hidden");
}

// ============================================================================
// LIGHTBOX
// ============================================================================
function openLightbox(url, caption) {
  document.getElementById("lightboxImg").src = url;
  document.getElementById("lightboxCaption").textContent = caption || "";
  document.getElementById("lightbox").classList.remove("hidden");
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================
function bindItemActionListeners() {
  document.querySelectorAll(".js-open-photo-modal").forEach((el) => {
    el.addEventListener("click", () => openPhotoModal(el.dataset.id));
  });

  document.querySelectorAll(".js-edit-item").forEach((el) => {
    el.addEventListener("click", () => openItemModal(el.dataset.id));
  });

  document.querySelectorAll(".js-zoom-photo").forEach((el) => {
    el.addEventListener("click", () => {
      const item = state.items.find((i) => i.id === el.dataset.id);
      if (item && item.imagens && item.imagens.length > 0) {
        openLightbox(
          item.imagens[0].dataUrl,
          `${item.item} (${item.segmento} - ${item.local}) | Condição: ${item.conservacao}`
        );
      }
    });
  });
}

function bindEvents() {
  // Navegação por Grupo (Visão Geral, Estoque Atual, Reposição 2027)
  document.querySelectorAll(".group-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeGroup = btn.dataset.group;
      state.quickCondFilter = null;
      renderAll();
    });
  });

  // Filtros e Busca
  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderAll();
  });

  document.getElementById("filterSegmento").addEventListener("change", (e) => {
    state.segmentFilter = e.target.value;
    renderAll();
  });

  document.getElementById("filterConservacao").addEventListener("change", (e) => {
    state.conservacaoFilter = e.target.value;
    state.quickCondFilter = null;
    renderAll();
  });

  document.getElementById("filterPrioridade").addEventListener("change", (e) => {
    state.prioridadeFilter = e.target.value;
    renderAll();
  });

  // Gestão de Segmentos
  document.getElementById("btnManageSegments").addEventListener("click", openSegmentManagerModal);
  document.getElementById("btnManageSegmentsTopbar").addEventListener("click", openSegmentManagerModal);
  const btnFilterSeg = document.getElementById("btnManageSegmentsFilter");
  if (btnFilterSeg) {
    btnFilterSeg.addEventListener("click", openSegmentManagerModal);
  }

  // Modal de Conexão Supabase Cloud
  const btnCloud = document.getElementById("btnCloudConfig");
  if (btnCloud) {
    btnCloud.addEventListener("click", () => {
      document.getElementById("supabaseModal").classList.remove("hidden");
    });
  }
  document.getElementById("closeSupabaseModal").addEventListener("click", () => {
    document.getElementById("supabaseModal").classList.add("hidden");
  });

  document.getElementById("btnConnectSupabase").addEventListener("click", async () => {
    const url = document.getElementById("inputSupabaseUrl").value.trim();
    const key = document.getElementById("inputSupabaseKey").value.trim();
    if (!url || !key) {
      alert("Por favor, preencha a Project URL e a API Key (anon/public) do Supabase.");
      return;
    }
    localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify({ url, key }));
    const ok = await initSupabaseConnection(url, key, true);
    if (ok) {
      alert("✅ Conectado ao Supabase com sucesso! Seus dados agora estão sincronizados online.");
    }
  });

  document.getElementById("btnPushLocalToCloud").addEventListener("click", async () => {
    if (!supabaseClient || !state.cloudConnected) {
      alert("Conecte-se ao Supabase primeiro.");
      return;
    }
    updateCloudStatusUI("syncing", "Enviando todos os itens locais para o Supabase...");
    const { error } = await supabaseClient.from(SUPABASE_ITEMS_TABLE).upsert(state.items);
    await saveSegmentsToDB(state.segmentos);
    if (error) {
      updateCloudStatusUI("offline", `Erro ao enviar: ${error.message}`);
    } else {
      updateCloudStatusUI("online", `Todos os ${state.items.length} itens locais foram enviados para a nuvem!`);
      alert("⬆️ Dados locais enviados para o Supabase com sucesso!");
    }
  });

  document.getElementById("btnPullCloudToLocal").addEventListener("click", async () => {
    if (!supabaseClient || !state.cloudConnected) {
      alert("Conecte-se ao Supabase primeiro.");
      return;
    }
    updateCloudStatusUI("syncing", "Baixando dados da nuvem...");
    const { data, error } = await supabaseClient.from(SUPABASE_ITEMS_TABLE).select("*");
    if (error) {
      updateCloudStatusUI("offline", `Erro ao baixar: ${error.message}`);
    } else if (data) {
      state.items = data;
      await saveAllItemsToLocalOnly(state.items);
      renderAll();
      updateCloudStatusUI("online", `${data.length} itens baixados da nuvem.`);
      alert("⬇️ Dados atualizados a partir da nuvem!");
    }
  });

  document.getElementById("btnDisconnectSupabase").addEventListener("click", () => {
    localStorage.removeItem(SUPABASE_CONFIG_KEY);
    if (realtimeChannel && supabaseClient) {
      supabaseClient.removeChannel(realtimeChannel);
    }
    supabaseClient = null;
    updateCloudStatusUI("offline", "Desconectado. Operando em modo local.");
  });

  document.getElementById("btnCopySql").addEventListener("click", () => {
    const sqlText = document.getElementById("sqlCodeBlock").textContent;
    navigator.clipboard.writeText(sqlText);
    const btn = document.getElementById("btnCopySql");
    btn.textContent = "✅ SQL Copiado!";
    setTimeout(() => (btn.textContent = "📋 Copiar SQL"), 2000);
  });
  document.getElementById("closeSegmentModal").addEventListener("click", () => {
    document.getElementById("segmentModal").classList.add("hidden");
  });
  document.getElementById("btnCloseSegmentModalBtn").addEventListener("click", () => {
    document.getElementById("segmentModal").classList.add("hidden");
  });
  document.getElementById("btnAddNewSegment").addEventListener("click", handleAddNewSegment);
  document.getElementById("newSegmentInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddNewSegment();
    }
  });

  // Atalho rápido no modal de item para criar segmento
  document.getElementById("linkCreateSegmentFast").addEventListener("click", (e) => {
    e.preventDefault();
    const newSeg = prompt("Digite o nome do novo segmento:");
    if (newSeg && newSeg.trim()) {
      const trimmed = newSeg.trim();
      if (!state.segmentos.includes(trimmed)) {
        state.segmentos.push(trimmed);
        saveSegmentsToDB(state.segmentos);
        renderSegmentSelectOptions();
        document.getElementById("formSegmento").value = trimmed;
      } else {
        document.getElementById("formSegmento").value = trimmed;
      }
    }
  });

  // KPIs clicáveis para filtro rápido de condição
  document.querySelectorAll(".kpi-clickable").forEach((card) => {
    card.addEventListener("click", () => {
      const targetCond = card.dataset.filterCond;
      state.quickCondFilter = state.quickCondFilter === targetCond ? null : targetCond;
      renderAll();
    });
  });

  // Alternância Cards / Tabela
  document.getElementById("btnViewCards").addEventListener("click", () => {
    state.viewMode = "cards";
    document.getElementById("btnViewCards").classList.add("active");
    document.getElementById("btnViewTable").classList.remove("active");
    renderItemsList();
  });

  document.getElementById("btnViewTable").addEventListener("click", () => {
    state.viewMode = "table";
    document.getElementById("btnViewTable").classList.add("active");
    document.getElementById("btnViewCards").classList.remove("active");
    renderItemsList();
  });

  // Modal de Fotos
  document.getElementById("closePhotoModal").addEventListener("click", () => {
    document.getElementById("photoModal").classList.add("hidden");
  });

  document.getElementById("photoFileInput").addEventListener("change", (e) => {
    handleFilesUpload(e.target.files);
    e.target.value = "";
  });

  const dropzone = document.getElementById("uploadDropzone");
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    handleFilesUpload(e.dataTransfer.files);
  });

  // Salvar status rápido de conservação dentro do modal de foto
  document.getElementById("btnSaveQuickCondition").addEventListener("click", async () => {
    if (!state.currentPhotoItemId) return;
    const item = state.items.find((i) => i.id === state.currentPhotoItemId);
    if (!item) return;

    item.conservacao = document.getElementById("modalQuickConservacao").value;
    item.observacoes = document.getElementById("modalQuickObs").value;
    await saveSingleItemToDB(item);
    renderAll();

    const btn = document.getElementById("btnSaveQuickCondition");
    const orig = btn.textContent;
    btn.textContent = "✅ Salvo!";
    setTimeout(() => (btn.textContent = orig), 1400);
  });

  // Modal de Item (Novo / Editar)
  document.getElementById("btnNewItem").addEventListener("click", () => openItemModal(null));
  document.getElementById("closeItemModal").addEventListener("click", () => {
    document.getElementById("itemModal").classList.add("hidden");
  });
  document.getElementById("cancelItemModal").addEventListener("click", () => {
    document.getElementById("itemModal").classList.add("hidden");
  });

  document.getElementById("itemForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("formItemId").value;

    const payload = {
      id: id || "custom-" + Date.now(),
      group: document.getElementById("formGroup").value,
      categoria: document.getElementById("formCategoria").value,
      segmento: document.getElementById("formSegmento").value,
      local: document.getElementById("formLocal").value,
      item: document.getElementById("formItemName").value,
      marcaModelo: document.getElementById("formMarcaModelo").value,
      quantidade: document.getElementById("formQuantidade").value,
      qntMinima: document.getElementById("formQntMinima").value || "-",
      conservacao: document.getElementById("formConservacao").value,
      prioridade: document.getElementById("formPrioridade").value,
      temNoColegio: document.getElementById("formTemNoColegio").value,
      observacoes: document.getElementById("formObservacoes").value,
      linkReferencia: document.getElementById("formLink").value
    };

    if (id) {
      const idx = state.items.findIndex((i) => i.id === id);
      if (idx > -1) {
        payload.imagens = state.items[idx].imagens || [];
        state.items[idx] = payload;
      }
    } else {
      payload.imagens = [];
      state.items.unshift(payload);
    }

    await saveSingleItemToDB(payload);
    document.getElementById("itemModal").classList.add("hidden");
    renderAll();
  });

  document.getElementById("btnDeleteItem").addEventListener("click", async () => {
    const id = document.getElementById("formItemId").value;
    if (!id) return;
    if (confirm("Deseja realmente excluir este item do controle de estoque?")) {
      state.items = state.items.filter((i) => i.id !== id);
      await deleteItemFromDB(id);
      document.getElementById("itemModal").classList.add("hidden");
      renderAll();
    }
  });

  // Lightbox
  document.getElementById("closeLightbox").addEventListener("click", () => {
    document.getElementById("lightbox").classList.add("hidden");
  });
  document.getElementById("lightbox").addEventListener("click", (e) => {
    if (e.target.id === "lightbox") {
      document.getElementById("lightbox").classList.add("hidden");
    }
  });

  // Exportar CSV
  document.getElementById("btnExportCSV").addEventListener("click", exportToCSV);

  // Exportar Backup JSON (com fotos e segmentos)
  document.getElementById("btnExportBackup").addEventListener("click", () => {
    const backupObj = {
      items: state.items,
      segmentos: state.segmentos,
      exportedAt: new Date().toISOString()
    };
    const dataStr = JSON.stringify(backupObj, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `backup_estoque_esportivo_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Importar Backup JSON
  document.getElementById("inputImportBackup").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (Array.isArray(imported)) {
          state.items = imported;
        } else if (imported && imported.items) {
          state.items = imported.items;
          if (Array.isArray(imported.segmentos)) {
            state.segmentos = imported.segmentos;
            await saveSegmentsToDB(state.segmentos);
          }
        }
        await saveAllItemsToDB(state.items);
        renderAll();
        alert("Backup importado com sucesso!");
      } catch (err) {
        alert("Arquivo de backup inválido.");
      }
    };
    reader.readAsText(file);
  });

  // Restaurar dados originais da planilha
  document.getElementById("btnResetData").addEventListener("click", async () => {
    if (confirm("Deseja restaurar os dados originais da planilha? Isso redefinirá os segmentos e itens para o estado inicial.")) {
      state.items = JSON.parse(JSON.stringify(INITIAL_INVENTORY_DATA));
      state.segmentos = [...INITIAL_SEGMENTOS];
      await saveAllItemsToDB(state.items);
      await saveSegmentsToDB(state.segmentos);
      renderAll();
    }
  });
}

function exportToCSV() {
  const headers = [
    "Grupo",
    "Segmento",
    "Local",
    "Categoria",
    "Item",
    "Marca/Modelo",
    "Quantidade",
    "Qnt. Minima",
    "Conservacao",
    "Prioridade",
    "Tem no Colegio",
    "Observacoes",
    "Fotos Anexadas",
    "Link de Referencia"
  ];

  const rows = state.items.map((i) => [
    i.group === "estoque_atual" ? "Estoque Atual" : "Reposicao 2027",
    i.segmento,
    i.local,
    i.categoria,
    i.item,
    i.marcaModelo,
    i.quantidade,
    i.qntMinima,
    i.conservacao,
    i.prioridade,
    i.temNoColegio,
    i.observacoes,
    i.imagens ? i.imagens.length : 0,
    i.linkReferencia
  ]);

  const csvContent =
    "\uFEFF" +
    [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(";"))
      .join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `controle_estoque_esportivo_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
