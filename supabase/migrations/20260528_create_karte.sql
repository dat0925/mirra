-- カルテテーブル作成
CREATE TABLE IF NOT EXISTS karte (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id        uuid REFERENCES salons(id) ON DELETE CASCADE,
  customer_id     uuid REFERENCES customers(id) ON DELETE CASCADE,
  appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,
  visited_at      date NOT NULL DEFAULT CURRENT_DATE,
  treatment       text,          -- 施術内容（例：カット、カラー）
  color_recipe    text,          -- カラーレシピ
  condition       text,          -- 髪の状態メモ
  notes           text,          -- 担当者メモ
  next_suggestion text,          -- 次回提案内容
  staff_name      text,          -- 担当スタッフ名
  created_at      timestamp WITH TIME ZONE DEFAULT now()
);

-- インデックス
CREATE INDEX IF NOT EXISTS karte_customer_id_idx ON karte(customer_id);
CREATE INDEX IF NOT EXISTS karte_salon_id_idx ON karte(salon_id);
CREATE INDEX IF NOT EXISTS karte_visited_at_idx ON karte(visited_at DESC);

-- RLS有効化
ALTER TABLE karte ENABLE ROW LEVEL SECURITY;

-- サービスロールは全操作可能
CREATE POLICY "service_role_all" ON karte
  FOR ALL TO service_role USING (true) WITH CHECK (true);
