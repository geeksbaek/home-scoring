import { useEffect, useMemo, useState } from "react";
import { APIProvider, Map as GoogleMap, AdvancedMarker, useMap } from "@vis.gl/react-google-maps";
import type { AptData } from "@/lib/scoring";

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY ?? "";
const MAP_ID = "2fc618fcc15fd5941df2ead6";

interface AptMapProps {
  data: AptData[];
  myLocation: { lat: number; lng: number } | null;
}

interface AptGroup {
  name: string;
  display_name: string;
  region: string;
  dong: string;
  lat: number;
  lng: number;
  build: number;
  households: number | null;
  hcode: string | null;
  types: AptData[];
}

function priceColor(avg: number): string {
  if (avg <= 50000) return "#22c55e";
  if (avg <= 70000) return "#3b82f6";
  if (avg <= 90000) return "#f59e0b";
  return "#ef4444";
}

function AptMarker({ group, isSelected, onClick, onClose }: { group: AptGroup; isSelected: boolean; onClick: (g: AptGroup) => void; onClose: () => void }) {
  // 마커 색상: 대표 타입(가장 높은 가격) 기준
  const mainType = group.types.reduce((a, b) => a.avg > b.avg ? a : b);
  const color = priceColor(mainType.avg);

  return (
    <AdvancedMarker
      position={{ lat: group.lat, lng: group.lng }}
      onClick={() => onClick(group)}
      zIndex={isSelected ? 1000 : 1}
    >
      <div style={{ position: "relative" }}>
        <div
          style={{
            width: 12, height: 12, borderRadius: "50%",
            backgroundColor: color, border: isSelected ? "2px solid #000" : "1.5px solid white",
            boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            cursor: "pointer",
          }}
        />
        {isSelected && (
          <div style={{
            position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)",
            background: "white", borderRadius: 8, padding: "10px 12px",
            boxShadow: "0 2px 12px rgba(0,0,0,0.25)", fontSize: 13, lineHeight: 1.7,
            minWidth: 220, maxWidth: 320, color: "#222", whiteSpace: "nowrap",
            zIndex: 10,
          }}>
            <button onClick={(e) => { e.stopPropagation(); onClose(); }} style={{
              position: "absolute", top: 4, right: 6, background: "none", border: "none",
              fontSize: 16, cursor: "pointer", color: "#999", lineHeight: 1,
            }}>✕</button>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2, paddingRight: 20, whiteSpace: "normal" }}>{group.display_name}</div>
            <div style={{ color: "#888", marginBottom: 4, fontSize: 12 }}>{group.region} {group.dong}</div>

            {group.types.map((t) => (
              <div key={t.atype} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "2px 0",
                borderTop: group.types.indexOf(t) > 0 ? "1px solid #eee" : "none",
              }}>
                <span style={{ color: "#666", fontSize: 12 }}>{t.area}㎡</span>
                <span>
                  <b style={{ color: priceColor(t.avg) }}>{(t.avg / 10000).toFixed(1)}억</b>
                  <span style={{
                    marginLeft: 6, fontSize: 12,
                    color: t.accel == null ? "#888" : t.accel >= 0 ? "#ef4444" : "#3b82f6",
                  }}>
                    {t.accel == null ? "-" : `${t.accel > 0 ? "+" : ""}${t.accel}%`}
                  </span>
                </span>
              </div>
            ))}

            <div style={{ color: "#888", fontSize: 12, marginTop: 2 }}>
              {group.build}년 준공{group.households ? ` · ${group.households.toLocaleString()}세대` : ""}
            </div>
            {group.hcode && (
              <div style={{ marginTop: 4 }}>
                <a href={`https://hogangnono.com/apt/${group.hcode}`} target="_blank" rel="noopener" style={{ color: "#3b82f6", textDecoration: "underline", fontSize: 12 }}>호갱노노</a>
              </div>
            )}
            <div style={{
              position: "absolute", bottom: -8, left: "50%", transform: "translateX(-50%)",
              width: 0, height: 0, borderLeft: "8px solid transparent",
              borderRight: "8px solid transparent", borderTop: "8px solid white",
            }} />
          </div>
        )}
      </div>
    </AdvancedMarker>
  );
}


// defaultCenter는 mount 시 1회만 적용 — geolocation이 지도 mount보다 늦게 도착하는
// 일반 케이스(지도 버튼 클릭과 동시에 위치 요청)에서 현재위치로 이동시키는 보조 컴포넌트.
function PanToLocation({ loc }: { loc: { lat: number; lng: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (map && loc) map.panTo(loc);
  }, [map, loc]);
  return null;
}

export default function AptMap({ data, myLocation }: AptMapProps) {
  const [selected, setSelected] = useState<string | null>(null);

  const center = useMemo(() => {
    if (myLocation) return myLocation;
    return { lat: 37.28, lng: 127.05 };
  }, [myLocation]);

  const groups = useMemo(() => {
    const map = new Map<string, AptGroup>();
    for (const d of data) {
      if (!d.lat || !d.lng) continue;
      const existing = map.get(d.name);
      if (existing) {
        existing.types.push(d);
      } else {
        map.set(d.name, {
          name: d.name,
          display_name: d.display_name || d.name,
          region: d.region,
          dong: d.dong,
          lat: d.lat,
          lng: d.lng,
          build: d.build,
          households: d.households,
          hcode: d.hcode,
          types: [d],
        });
      }
    }
    // 타입을 면적 순 정렬
    for (const g of map.values()) {
      g.types.sort((a, b) => a.area - b.area);
    }
    return [...map.values()];
  }, [data]);

  if (!GOOGLE_MAPS_KEY) {
    return <div className="w-full h-[500px] rounded-lg border flex items-center justify-center text-muted-foreground">VITE_GOOGLE_MAPS_KEY 필요</div>;
  }

  return (
    <>
      <APIProvider apiKey={GOOGLE_MAPS_KEY}>
        <div className="w-full rounded-lg border overflow-hidden" style={{ height: "500px" }}>
          <GoogleMap
            defaultCenter={center}
            defaultZoom={11}
            mapId={MAP_ID}
            gestureHandling="greedy"
            streetViewControl={false}
            mapTypeControl={true}
            zoomControl={true}
          >
            <PanToLocation loc={myLocation} />
            {myLocation && (
              <AdvancedMarker position={myLocation}>
                <div style={{
                  width: 16, height: 16, borderRadius: "50%",
                  backgroundColor: "#6366f1", border: "3px solid white",
                  boxShadow: "0 0 8px rgba(99,102,241,0.5)",
                }} />
              </AdvancedMarker>
            )}

            {groups.map((g) => (
              <AptMarker key={g.name} group={g} isSelected={selected === g.name} onClick={(g) => setSelected(g.name)} onClose={() => setSelected(null)} />
            ))}
          </GoogleMap>
        </div>
      </APIProvider>
      <div className="flex gap-3 mt-2 text-xs text-muted-foreground">
        <span><span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: "#22c55e" }} /> ~5억</span>
        <span><span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: "#3b82f6" }} /> 5~7억</span>
        <span><span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: "#f59e0b" }} /> 7~9억</span>
        <span><span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: "#ef4444" }} /> 9억+</span>
        {myLocation && <span><span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: "#6366f1" }} /> 현재위치</span>}
      </div>
    </>
  );
}
