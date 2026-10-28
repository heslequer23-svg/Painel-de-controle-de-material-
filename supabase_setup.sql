-- ============================================================================
-- SCRIPT DE CRIAÇÃO DAS TABELAS NO SUPABASE (Controle de Estoque Esportivo)
-- Cole este código no "SQL Editor" do seu painel Supabase e clique em "Run"
-- ============================================================================

-- 1. Tabela de Itens do Estoque e Reposição 2027
CREATE TABLE IF NOT EXISTS public.estoque_esportivo_itens (
  id TEXT PRIMARY KEY,
  "group" TEXT NOT NULL DEFAULT 'estoque_atual',
  segmento TEXT NOT NULL DEFAULT 'EFAF',
  local TEXT NOT NULL DEFAULT '',
  categoria TEXT NOT NULL DEFAULT 'Vôlei',
  item TEXT NOT NULL,
  "marcaModelo" TEXT DEFAULT '',
  quantidade TEXT DEFAULT '0',
  "qntMinima" TEXT DEFAULT '-',
  conservacao TEXT DEFAULT 'Bom',
  observacoes TEXT DEFAULT '',
  prioridade TEXT DEFAULT 'Normal',
  "temNoColegio" TEXT DEFAULT 'Sim',
  "linkReferencia" TEXT DEFAULT '',
  imagens JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tabela de Configurações / Segmentos Dinâmicos
CREATE TABLE IF NOT EXISTS public.estoque_esportivo_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Habilitar Row Level Security (RLS) com política de acesso público (Anon Key)
ALTER TABLE public.estoque_esportivo_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estoque_esportivo_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Acesso Total Publico Itens" ON public.estoque_esportivo_itens;
CREATE POLICY "Acesso Total Publico Itens"
  ON public.estoque_esportivo_itens
  FOR ALL
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Acesso Total Publico Config" ON public.estoque_esportivo_config;
CREATE POLICY "Acesso Total Publico Config"
  ON public.estoque_esportivo_config
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- 4. Habilitar Realtime para sincronização instantânea entre dispositivos
ALTER PUBLICATION supabase_realtime ADD TABLE public.estoque_esportivo_itens;
ALTER PUBLICATION supabase_realtime ADD TABLE public.estoque_esportivo_config;
