// Lógica do Dashboard de Controle de Estoque Esportivo (EFAF, EM, EFAI)
// Inclui armazenamento persistente IndexedDB para fotos de condição dos itens

const DB_NAME = "EstoqueEsportivoDB_v1";
const STORE_NAME = "inventory_items";

let state = {
  items: [],
  activeGroup: "todos",         // 'todos' | 'estoque_atual' | 'reposicao_2027'
  activeCategory: "Todas",      // 'Todas' | 'Vôlei' | 'Basquete' | ...
  searchQuery: "",
  segmentFilter: "TODOS",
  conservacaoFilter: "TODOS",
  prioridadeFilter: "TODOS",
  quickCondFilter: null,        // 'ok' | 'medio' | 'pessimo' | 'com_foto'
  viewMode: "cards",            // 'cards' | 'table'
  currentPhotoItemId: null
};

// ============================================================================
// CAMADA DE BANCO DE DADOS LOCAL (IndexedDB para suportar múltiplas fotos)
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

async function loadItemsFromDB() {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("Fallback para LocalStorage:", err);
    const saved = localStorage.getItem(DB_NAME);
    return saved ? JSON.parse(saved) : [];
  }
}

async function saveAllItemsToDB(items) {
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

async function saveSingleItemToDB(item) {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    localStorage.setItem(DB_NAME, JSON.stringify(state.items));
  }
}

async function deleteItemFromDB(id) {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    localStorage.setItem(DB_NAME, JSON.stringify(state.items));
  }
}

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  const stored = await loadItemsFromDB();
  if (stored && stored.length > 0) {
    state.items = stored;
  } else {
    state.items = JSON.parse(JSON.stringify(INITIAL_INVENTORY_DATA));
    await saveAllItemsToDB(state.items);
  }

  bindEvents();
  renderAll();
});

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

    // 3. Filtro de Segmento
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
      if (state.quickCondFilter === "medio" && !(c === "bom/médio" || c === "médio" || c === "medio")) return false;
      if (state.quickCondFilter === "pessimo" && !(c === "médio/péssimo" || c === "péssimo" || c === "pessimo")) return false;
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
  const groupLabels = {
    todos: "Estoque Atual + Reposição 2027",
    estoque_atual: "Estoque Atual (Primeira Gaiola EFAF • Gaiola Elevador EM • Bolsa EFAI)",
    reposicao_2027: "Planejamento de Compras & Reposição 2027 (EFAF • EM • EFAI)"
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
        <p style="color: var(--text-muted); margin: 0.5rem 0 1.25rem;">Tente limpar a busca ou selecionar "Todas as Categorias".</p>
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

  if (itemId) {
    const item = state.items.find((i) => i.id === itemId);
    if (!item) return;

    document.getElementById("itemModalTitle").textContent = "✏️ Editar Item";
    document.getElementById("formItemId").value = item.id;
    document.getElementById("formGroup").value = item.group || "estoque_atual";
    document.getElementById("formCategoria").value = item.categoria || "Vôlei";
    document.getElementById("formSegmento").value = item.segmento || "EFAF";
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

  // Exportar Backup JSON (com fotos)
  document.getElementById("btnExportBackup").addEventListener("click", () => {
    const dataStr = JSON.stringify(state.items, null, 2);
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
          await saveAllItemsToDB(state.items);
          renderAll();
          alert("Backup importado com sucesso!");
        }
      } catch (err) {
        alert("Arquivo de backup inválido.");
      }
    };
    reader.readAsText(file);
  });

  // Restaurar dados originais da planilha
  document.getElementById("btnResetData").addEventListener("click", async () => {
    if (confirm("Deseja restaurar os dados originais da planilha? Isso removerá edições ou fotos adicionadas.")) {
      state.items = JSON.parse(JSON.stringify(INITIAL_INVENTORY_DATA));
      await saveAllItemsToDB(state.items);
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
