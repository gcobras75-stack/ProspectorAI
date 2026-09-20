/**
 * MaterialPicker.tsx — selector de material objetivo (web).
 *
 * La UI es nueva (ConfigModal nativo está atado a SQLite/SyncEngine y a controles de campo),
 * pero TODA la lógica sale del catálogo compartido: MATERIALS_CATALOG, CATEGORIES (metálicos
 * primero, luego especiales), CATEGORIES_EXPANDED_BY_DEFAULT y selectorConfidence. Igual que
 * el modal nativo: búsqueda, categorías plegables (buscando, todo se abre) y badge de
 * confianza con su pista.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import {
  CATEGORIES, CATEGORIES_EXPANDED_BY_DEFAULT, MATERIALS_CATALOG, selectorConfidence,
} from '../app/core/materialsCatalog';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export default function MaterialPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const c of CATEGORIES) init[c.id] = (CATEGORIES_EXPANDED_BY_DEFAULT as string[]).includes(c.id);
    return init;
  });
  const searching = query.trim().length > 0;

  const groups = useMemo(() => {
    const q = norm(query.trim());
    return CATEGORIES
      .map((cat) => ({
        cat,
        items: MATERIALS_CATALOG.filter((m) => m.category === cat.id && (!q || norm(m.label).includes(q) || norm(m.id).includes(q))),
      }))
      .filter((g) => g.items.length > 0);
  }, [query]);

  return (
    <View>
      <TextInput
        style={s.search} value={query} onChangeText={setQuery}
        placeholder="🔍 Buscar material… (oro, mármol, yeso…)" placeholderTextColor="#777"
        autoCapitalize="none" autoCorrect={false}
      />
      {groups.length === 0 && <Text style={s.none}>Sin resultados para “{query}”.</Text>}
      {groups.map(({ cat, items }) => {
        // Buscando, todo se muestra abierto: colapsar resultados sería esconder lo pedido.
        const open = searching || !!expanded[cat.id];
        return (
          <View key={cat.id} style={{ marginBottom: 6 }}>
            <TouchableOpacity
              style={s.catRow} activeOpacity={searching ? 1 : 0.7}
              onPress={() => { if (!searching) setExpanded((e) => ({ ...e, [cat.id]: !e[cat.id] })); }}
            >
              <Text style={s.catHead}>{cat.icon}  {cat.label.toUpperCase()} ({items.length})</Text>
              {!searching && <Text style={s.chev}>{open ? '▾' : '▸'}</Text>}
            </TouchableOpacity>
            {open && items.map((m) => {
              const active = value === m.id;
              const conf = selectorConfidence(m);
              return (
                <TouchableOpacity key={m.id} style={[s.row, active && s.rowOn]} onPress={() => onChange(m.id)}>
                  <Text style={s.icon}>{m.icon}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.label, active && s.labelOn]} numberOfLines={1}>{m.label}</Text>
                    {conf.hint ? <Text style={s.hint} numberOfLines={1}>{conf.hint}</Text> : null}
                  </View>
                  <View style={[s.badge, { backgroundColor: conf.color }]}><Text style={s.badgeText}>{conf.label}</Text></View>
                </TouchableOpacity>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  search: { backgroundColor: '#161616', borderColor: '#2A2A2A', borderWidth: 1, borderRadius: 10, color: '#FFF', paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, marginBottom: 10 },
  none: { color: '#888', fontSize: 12, marginBottom: 8 },
  catRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  catHead: { color: '#FFD700', fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
  chev: { color: '#FFD700', fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#141414', borderColor: '#242424', borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 10, marginBottom: 6 },
  rowOn: { borderColor: '#FFD700', backgroundColor: '#2A2410' },
  icon: { fontSize: 20, marginRight: 10 },
  label: { color: '#EEE', fontSize: 15, fontWeight: '600' },
  labelOn: { color: '#FFD700' },
  hint: { color: '#8A8A8A', fontSize: 11, marginTop: 1 },
  badge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, marginLeft: 8 },
  badgeText: { color: '#000', fontSize: 11, fontWeight: '800' },
});
