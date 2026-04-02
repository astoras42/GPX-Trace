#!/usr/bin/env python3
"""
Generateur de trace GPX Enduro
Depart/Arrivee : Vabre
Distance cible : ~160 km
Sentiers/chemins souhaites : ~85%
Source : OpenStreetMap via API Overpass

Usage:
    pip install requests gpxpy
    python enduro_gpx.py
"""

import requests, math, gpxpy, gpxpy.gpx, time, heapq
from collections import defaultdict

HIGHWAY_COST = {
    "track":        1.0,
    "path":         0.9,
    "unclassified": 17,
    "tertiary":     34,
    "secondary":    51,
}

OVERLAP = 0.06

LAT_C = 43.69381
LON_C = 2.42552

CIRCUIT_WAYPOINTS = [
    {"name": "DEPART - Vabre", "lat": 43.69381, "lon": 2.42552},
    {"name": "WP1", "lat": 43.53015, "lon": 2.42552},
    {"name": "WP2", "lat": 43.59177, "lon": 2.60248},
    {"name": "WP3", "lat": 43.73022, "lon": 2.64619},
    {"name": "WP4", "lat": 43.84126, "lon": 2.52373},
    {"name": "WP5", "lat": 43.84126, "lon": 2.32731},
    {"name": "WP6", "lat": 43.73022, "lon": 2.20485},
    {"name": "WP7", "lat": 43.59177, "lon": 2.24856},
    {"name": "ARRIVEE - Vabre", "lat": 43.69381, "lon": 2.42552},
]

BBOXES = []
for frac_lat in [(0,0.55),(0.45,1)]:
    for frac_lon in [(0,0.55),(0.45,1)]:
        lats = [w["lat"] for w in CIRCUIT_WAYPOINTS]
        lons = [w["lon"] for w in CIRCUIT_WAYPOINTS]
        lat_min, lat_max = min(lats)-0.05, max(lats)+0.05
        lon_min, lon_max = min(lons)-0.05, max(lons)+0.05
        lat_range = lat_max - lat_min
        lon_range = lon_max - lon_min
        BBOXES.append((
            lat_min + frac_lat[0]*lat_range - OVERLAP,
            lon_min + frac_lon[0]*lon_range - OVERLAP,
            lat_min + frac_lat[1]*lat_range + OVERLAP,
            lon_min + frac_lon[1]*lon_range + OVERLAP,
        ))

OVERPASS_SERVERS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

def fetch_tile(bbox, server):
    lat_min, lon_min, lat_max, lon_max = bbox
    query = (
        "[out:json][timeout:90];"
        "("
        f'way["highway"="track"]({lat_min},{lon_min},{lat_max},{lon_max});'
        f'way["highway"="path"]({lat_min},{lon_min},{lat_max},{lon_max});'
        f'way["highway"="unclassified"]({lat_min},{lon_min},{lat_max},{lon_max});'
        f'way["highway"="tertiary"]({lat_min},{lon_min},{lat_max},{lon_max});'
        f'way["highway"="secondary"]({lat_min},{lon_min},{lat_max},{lon_max});'
        ");"
        "out geom tags;"
    )
    resp = requests.post(server, data={"data": query}, timeout=120)
    resp.raise_for_status()
    return resp.json()["elements"]

def fetch_all():
    all_e, seen = [], set()
    for i, bbox in enumerate(BBOXES):
        print(f"  Tuile {i+1}/{len(BBOXES)}...")
        for server in OVERPASS_SERVERS:
            sname = server.split('/')[2]
            try:
                elems = fetch_tile(bbox, server)
                nb = sum(1 for e in elems if e["id"] not in seen)
                for e in elems:
                    if e["id"] not in seen:
                        seen.add(e["id"]); all_e.append(e)
                print(f"    OK ({sname}) - {nb} nouveaux"); time.sleep(3); break
            except Exception as ex:
                print(f"    Echec {sname}: {ex}"); time.sleep(2)
    print(f"  Total : {len(all_e)} chemins OSM")
    return all_e

def haversine(lat1,lon1,lat2,lon2):
    R=6371000; p1,p2=math.radians(lat1),math.radians(lat2)
    dp=math.radians(lat2-lat1); dl=math.radians(lon2-lon1)
    a=math.sin(dp/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return R*2*math.atan2(math.sqrt(a),math.sqrt(1-a))

def build_graph(elements):
    coords, adj = {}, defaultdict(list)
    for way in elements:
        if "geometry" not in way or len(way["geometry"])<2: continue
        hw = way.get("tags",{}).get("highway","track")
        mult = HIGHWAY_COST.get(hw, 5.0)
        geom = way["geometry"]
        nids = [(round(p["lat"],5), round(p["lon"],5)) for p in geom]
        for pt,nid in zip(geom,nids):
            coords[nid] = (pt["lat"], pt["lon"])
        for i in range(1,len(nids)):
            a,b = nids[i-1],nids[i]
            la,loa = coords[a]; lb,lob = coords[b]
            d = haversine(la,loa,lb,lob)
            adj[a].append((b,d,d*mult,hw)); adj[b].append((a,d,d*mult,hw))
    return coords, adj

def nearest(lat,lon,coords):
    best,bd = None,float("inf")
    for nid,(nlat,nlon) in coords.items():
        d=haversine(lat,lon,nlat,nlon)
        if d<bd: bd=d; best=nid
    return best,bd

def dijkstra(s,e,coords,adj):
    heap=[(0.0,s,[s],0.0,defaultdict(float))]; vis={}
    while heap:
        cost,cur,path,real,stats = heapq.heappop(heap)
        if cur in vis: continue
        vis[cur]=True
        if cur==e: return path,real,stats
        for nb,dr,cost_w,hw in adj[cur]:
            if nb not in vis:
                nc=cost+cost_w
                if nc<vis.get(nb,float("inf")):
                    ns=defaultdict(float,stats); ns[hw]+=dr
                    heapq.heappush(heap,(nc,nb,path+[nb],real+dr,ns))
    return None,float("inf"),defaultdict(float)

def main():
    print("="*60)
    print(f"  GPX Enduro - Vabre ~160km / ~85% pistes")
    print("="*60)

    print("\n[1/4] Recuperation OSM...")
    elements = fetch_all()
    if not elements: print("ERREUR : aucun chemin."); return

    print("\n[2/4] Construction du graphe...")
    coords, adj = build_graph(elements)
    print(f"      {len(coords)} noeuds, {sum(len(v) for v in adj.values())//2} aretes")

    print("\n[3/4] Accrochage des waypoints...")
    snapped = []
    for wp in CIRCUIT_WAYPOINTS:
        node, dist = nearest(wp["lat"], wp["lon"], coords)
        print(f"      {wp['name']:40s} {dist:5.0f}m")
        snapped.append({**wp, "node": node})

    print("\n[4/4] Calcul de l itineraire...")
    all_pts, total, gstats, ndirect = [], 0, defaultdict(float), 0
    for i in range(len(snapped)-1):
        s,e = snapped[i],snapped[i+1]
        print(f"      {s['name']} -> {e['name']}...", end=" ", flush=True)
        path,real,stats = dijkstra(s["node"],e["node"],coords,adj)
        if path is None:
            print("LIAISON DIRECTE")
            ndirect+=1
            steps=30
            for k in range(steps+1):
                t=k/steps
                all_pts.append({"lat":s["lat"]+t*(e["lat"]-s["lat"]),"lon":s["lon"]+t*(e["lon"]-s["lon"])})
        else:
            total+=real
            for hw,d in stats.items(): gstats[hw]+=d
            for nd in path: la,lo=coords[nd]; all_pts.append({"lat":la,"lon":lo})
            print(f"OK  {real/1000:.1f}km")

    all_pts.append({"lat":snapped[-1]["lat"],"lon":snapped[-1]["lon"]})

    off=gstats.get("track",0)+gstats.get("path",0)
    road=total-off
    print(f"\n  Distance totale : {total/1000:.1f} km")
    if total>0:
        print(f"  Pistes+sentiers : {100*off/total:.0f}%  ({off/1000:.1f}km)")
        print(f"  Routes          : {100*road/total:.0f}%  ({road/1000:.1f}km)")
    if ndirect: print(f"  Liaisons directes : {ndirect}")

    gpx=gpxpy.gpx.GPX()
    gpx.name="Enduro ~160km - Vabre"
    gpx.description="Circuit enduro, source OpenStreetMap."
    for wp in CIRCUIT_WAYPOINTS:
        gpx.waypoints.append(gpxpy.gpx.GPXWaypoint(wp["lat"],wp["lon"],name=wp["name"]))
    trk=gpxpy.gpx.GPXTrack(); trk.name="Enduro ~160km - Vabre"; gpx.tracks.append(trk)
    seg=gpxpy.gpx.GPXTrackSegment(); trk.segments.append(seg)
    for p in all_pts: seg.points.append(gpxpy.gpx.GPXTrackPoint(p["lat"],p["lon"]))

    fname="enduro_vabre_160km.gpx"
    with open(fname,"w",encoding="utf-8") as f: f.write(gpx.to_xml())
    print(f"\n  Fichier : {fname}  ({len(all_pts)} points)\n")

if __name__=="__main__":
    main()
