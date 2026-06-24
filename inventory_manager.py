# =============================================================================
# inventory_manager.py - Core Inventory Management Logic
# =============================================================================

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional, Set, Tuple
import re
import streamlit as st

# ── CONSTANTS ──────────────────────────────────────────────────────────────

REQUIRED_COLUMNS = [
    "Material", "Material Description", "Plant", "Plant Name",
    "Storage Location", "Description of Storage Location",
    "Special Stock Type", "Special Stock Type Description",
    "Unrestricted Stock", "Stock in Quality Inspection", "Blocked Stock",
    "Batch", "Inventory Valuation Type", "Material Group Name",
    "Shelf Life Expiration Date", "Stock in Transit",
    "Value of Stock in Quality Inspection", "Value of Stock in Transit",
    "Value of Unrestricted Stock",
]

COLORWAY = ["#3a8fd4", "#2e9e5a", "#c47f17", "#d94040", "#8763cc", 
            "#5cbfdb", "#4db87a", "#e09b2d", "#e86060", "#a78bde", 
            "#59b8f5", "#70ce94"]

# ── EXCLUSION RULES ──────────────────────────────────────────────────────

def is_medical_code(code: str) -> bool:
    """Returns True if the material code is a valid pharmaceutical code."""
    if not code:
        return False
    c = str(code).strip()
    if not c:
        return False
    return bool(re.match(r'^[1234]', c))

def is_non_medical_code(code: str) -> bool:
    """Returns True if the material code should be excluded."""
    if not code:
        return True
    c = str(code).strip().upper()
    if not c:
        return True
    if c.startswith("NT"):
        return True
    return not is_medical_code(c)

def is_non_medical_group(group_name: str) -> bool:
    """Returns True if the material group should be excluded."""
    if not group_name:
        return False
    g = str(group_name).strip().upper()
    if not g:
        return False
    
    EXCLUDED_GROUPS = [
        "NON TRADE", "NON-TRADE", "NONTRADE", "PROJECT STOCK",
        "SERVICES", "ASSETS", "OFFICE SUPPLIES", "STATIONERY",
        "SPARE PARTS", "EQUIPMENT", "FURNITURE"
    ]
    return any(ex in g for ex in EXCLUDED_GROUPS)

def is_project_stock_description(description: str) -> bool:
    """Returns True if the description indicates Project Stock."""
    if not description:
        return False
    d = str(description).strip().upper()
    if not d:
        return False
    return d == "PROJECT STOCK"

def is_excluded_storage_location(storage_loc: str) -> bool:
    """Returns True if the storage location should be excluded."""
    if not storage_loc:
        return False
    s = str(storage_loc).strip().upper()
    if not s:
        return False
    
    EXCLUDED_LOCATIONS = [
        "AA1G", "AA2G", "ADG1", "ARG1", "ASG1",
        "BDG1", "DDG1", "DEG1", "GAG1", "GOG1",
        "HAG1", "HOG1", "HOG2", "JIG1", "JJG1",
        "KDG1", "MKG1", "NBG1", "NKG1", "SEG1", "SHG1"
    ]
    return s in EXCLUDED_LOCATIONS

def get_valuation_type(row: Dict) -> str:
    """Extracts the valuation type suffix from Inventory Valuation Type."""
    if not row:
        return "(None)"
    raw = str(row.get("Inventory Valuation Type", "")).strip()
    if not raw:
        return "(None)"
    last_underscore = raw.rfind("_")
    if last_underscore == -1 or last_underscore == len(raw) - 1:
        return raw.upper() if raw else "(None)"
    return raw[last_underscore + 1:].upper()

# ── FORMAT HELPERS ──────────────────────────────────────────────────────

def fmt_etb(v) -> str:
    """Format value as ETB currency."""
    try:
        return f"ETB {float(v or 0):,.0f}"
    except:
        return "ETB 0"

def fmt_qty(v) -> str:
    """Format quantity with commas."""
    try:
        return f"{float(v or 0):,.0f}"
    except:
        return "0"

def fmt_pct(v) -> str:
    """Format percentage."""
    try:
        return f"{float(v or 0):.1f}%"
    except:
        return "0%"

def fmt_local_date(d) -> str:
    """Format date as YYYY-MM-DD."""
    if not d:
        return ""
    if isinstance(d, datetime):
        return d.strftime("%Y-%m-%d")
    try:
        dt = pd.to_datetime(d)
        return dt.strftime("%Y-%m-%d")
    except:
        return str(d)

def parse_expiry_date(d) -> Optional[datetime]:
    """Parse expiry date, treating YYYY-MM-DD as local date."""
    if d is None or (isinstance(d, float) and pd.isna(d)):
        return None
    if isinstance(d, datetime):
        if pd.isna(d):
            return None
        return d.replace(hour=0, minute=0, second=0, microsecond=0)
    if isinstance(d, pd.Timestamp):
        if pd.isna(d):
            return None
        return d.to_pydatetime().replace(hour=0, minute=0, second=0, microsecond=0)
    
    s = str(d).strip()
    if not s:
        return None
    
    iso_match = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', s)
    if iso_match:
        try:
            return datetime(int(iso_match.group(1)), int(iso_match.group(2)), int(iso_match.group(3)))
        except ValueError:
            return None
    
    try:
        dt = pd.to_datetime(s)
        if pd.isna(dt):
            return None
        return dt.to_pydatetime().replace(hour=0, minute=0, second=0, microsecond=0)
    except:
        return None

def parse_posting_date(v) -> Optional[datetime]:
    """Parse posting date with Excel serial number support."""
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, datetime):
        if pd.isna(v):
            return None
        return v.replace(hour=0, minute=0, second=0, microsecond=0)
    if isinstance(v, pd.Timestamp):
        if pd.isna(v):
            return None
        return v.to_pydatetime().replace(hour=0, minute=0, second=0, microsecond=0)
    
    s = str(v).strip()
    if not s:
        return None
    
    iso_match = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', s)
    if iso_match:
        try:
            return datetime(int(iso_match.group(1)), int(iso_match.group(2)), int(iso_match.group(3)))
        except ValueError:
            return None
    
    try:
        n = float(s)
        if 1000 < n < 2958466:
            base = datetime(1900, 1, 1)
            return base + timedelta(days=n - 2)
    except:
        pass
    
    try:
        dt = pd.to_datetime(s)
        if pd.isna(dt):
            return None
        return dt.to_pydatetime().replace(hour=0, minute=0, second=0, microsecond=0)
    except:
        return None

# ── PROCESSING FUNCTIONS ──────────────────────────────────────────────────

def process_inventory_file(df: pd.DataFrame) -> Tuple[List[Dict], List[str]]:
    """Process inventory Excel file."""
    if df is None or df.empty:
        return [], ["File is empty"]
    
    # Rename columns to match expected format
    columns = {k: k.strip() for k in df.columns}
    df = df.rename(columns=columns)
    
    errors = []
    
    # Check required columns
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        errors.append(f"Missing columns: {', '.join(missing)}")
        return [], errors
    
    # Convert to dict
    data = df.to_dict('records')
    
    # Filter out excluded rows
    filtered = []
    for r in data:
        special_stock = str(r.get("Special Stock Type", "")).strip().upper()
        if special_stock in ("Q", "W"):
            continue
        if is_project_stock_description(r.get("Special Stock Type Description")):
            continue
        if is_non_medical_code(r.get("Material")):
            continue
        if is_non_medical_group(r.get("Material Group Name")):
            continue
        if is_excluded_storage_location(r.get("Storage Location")):
            continue
        if str(r.get("Inventory Valuation Type", "")).strip() == "":
            continue
        filtered.append(r)
    
    # Parse numeric columns
    num_cols = [
        "Unrestricted Stock", "Stock in Quality Inspection", "Blocked Stock", "Stock in Transit",
        "Value of Stock in Quality Inspection", "Value of Stock in Transit", "Value of Unrestricted Stock",
    ]
    
    for r in filtered:
        for c in num_cols:
            try:
                r[c] = float(r.get(c, 0) or 0)
            except:
                r[c] = 0
        r["_expiry"] = parse_expiry_date(r.get("Shelf Life Expiration Date"))
        r["Total Value"] = (r.get("Value of Unrestricted Stock", 0) + 
                            r.get("Value of Stock in Transit", 0) + 
                            r.get("Value of Stock in Quality Inspection", 0))
        r["Total Qty"] = (r.get("Unrestricted Stock", 0) + 
                          r.get("Stock in Transit", 0) + 
                          r.get("Stock in Quality Inspection", 0))
    
    # Filter out rows with zero stock
    filtered = [r for r in filtered if (
        r.get("Unrestricted Stock", 0) > 0 or
        r.get("Stock in Transit", 0) > 0 or
        r.get("Stock in Quality Inspection", 0) > 0 or
        r.get("Blocked Stock", 0) > 0
    )]
    
    return filtered, errors

def process_transit_file(df: pd.DataFrame) -> Tuple[List[Dict], List[str]]:
    """Process transit Excel file."""
    if df is None or df.empty:
        return [], ["File is empty"]
    
    errors = []
    data = df.to_dict('records')
    
    # Trim column names
    for r in data:
        r = {k.strip(): v for k, v in r.items()}
    
    # Normalize columns
    rows = []
    for r in data:
        mat = str(r.get("Material", "")).strip()
        if not mat or is_non_medical_code(mat):
            continue
        
        grp = str(r.get("Material Group Name", "")).strip()
        if grp and is_non_medical_group(grp):
            continue
        
        raw_pur_doc = str(r.get("Purchasing Document", "")).strip()
        pur_doc = raw_pur_doc
        if re.search(r'e', raw_pur_doc, re.I):
            try:
                pur_doc = str(int(float(raw_pur_doc)))
            except:
                pass
        
        rows.append({
            "_st_material": mat,
            "_st_desc": str(r.get("Material Description", "")).strip(),
            "_st_plant": str(r.get("Plant", "")).strip(),
            "_st_plant_name": str(r.get("Name 1", r.get("Plant Name", ""))).strip(),
            "_st_pur_doc": pur_doc,
            "_st_sup_plant": str(r.get("Supplying Plant", "")).strip(),
            "_st_qty": float(r.get("Quantity", r.get("Order Quantity", 0)) or 0),
            "_st_uom": str(r.get("Base Unit of Measure", r.get("Order Unit", ""))).strip(),
            "_st_item": str(r.get("Item", "")).strip(),
            "_st_special_stock": str(r.get("Special Stock", "")).strip(),
        })
    
    return rows, errors

def process_incoming_file(df: pd.DataFrame) -> Tuple[List[Dict], List[str]]:
    """Process incoming goods Excel file."""
    if df is None or df.empty:
        return [], ["File is empty"]
    
    errors = []
    ALLOWED_VT = ["ZME", "ZMS", "ZLC"]
    
    data = df.to_dict('records')
    rows = []
    
    for r in data:
        plant = str(r.get("Plant", "")).strip().upper()
        if plant != "HO01":
            continue
        
        raw_vt = str(r.get("Valuation Type", r.get("Inventory Valuation Type", ""))).strip()
        vt = raw_vt
        i = raw_vt.rfind("_")
        if i != -1 and i < len(raw_vt) - 1:
            vt = raw_vt[i + 1:].upper()
        else:
            vt = raw_vt.upper()
        
        if vt not in ALLOWED_VT:
            continue
        
        rows.append({
            "Material": str(r.get("Material", "")).strip(),
            "Material Description": str(r.get("Material Description", "")).strip(),
            "Batch": str(r.get("Batch", "")).strip(),
            "Plant": plant,
            "Storage Location": str(r.get("Storage Location", "")).strip(),
            "Material Document": str(r.get("Material Document", r.get("GR Document", ""))).strip(),
            "Quantity": float(r.get("Quantity", r.get("Posted Quantity", r.get("GR Quantity", 0))) or 0),
            "_posting_date": parse_posting_date(r.get("Posting Date")),
            "_vt": vt,
            "_inv_plants": "—",
            "_inv_slocs": "—",
            "_inv_total_qty": 0,
            "_inv_expiry_date": None,
            "_inv_material_group": "—",
            "_in_inventory": None,
            "_sl_at_receipt_days": None,
            "_receipt_flag": "grey",
            "_remaining_sl": None,
            "_ratio": None,
            "_flag": "grey",
            "_is_expired": False,
            "_data_error": False,
        })
    
    return rows, errors

# ── AGGREGATION HELPERS ──────────────────────────────────────────────

def group_by(data: List[Dict], key: str, agg_cols: List[Tuple[str, str]]) -> List[Dict]:
    """Group data by a key and aggregate columns."""
    if not data:
        return []
    result = {}
    for row in data:
        k = row.get(key, "(Blank)")
        if not k:
            k = "(Blank)"
        if k not in result:
            result[k] = {key: k}
            for col, _ in agg_cols:
                result[k][col] = 0
        for col, src in agg_cols:
            result[k][col] += float(row.get(src, 0) or 0)
    return list(result.values())

def sort_by(arr: List[Dict], key: str, asc: bool = False) -> List[Dict]:
    """Sort a list of dicts by a key."""
    return sorted(arr, key=lambda x: x.get(key, 0), reverse=not asc)

def aggregate_by_material(df: List[Dict]) -> List[Dict]:
    """Aggregate rows by material code."""
    if not df:
        return []
    
    QTY_COLS = ["Unrestricted Stock", "Stock in Quality Inspection", "Blocked Stock", "Stock in Transit"]
    VAL_COLS = ["Value of Unrestricted Stock", "Value of Stock in Quality Inspection", "Value of Stock in Transit"]
    
    mat_map = {}
    for row in df:
        mat = row.get("Material")
        if not mat:
            continue
        
        if mat not in mat_map:
            mat_map[mat] = dict(row)
            mat_map[mat]["_all_plants"] = []
            if row.get("Plant Name"):
                mat_map[mat]["_all_plants"].append(row["Plant Name"])
        else:
            target = mat_map[mat]
            for c in QTY_COLS:
                target[c] = float(target.get(c, 0) or 0) + float(row.get(c, 0) or 0)
            for c in VAL_COLS:
                target[c] = float(target.get(c, 0) or 0) + float(row.get(c, 0) or 0)
            te = target.get("_expiry")
            se = row.get("_expiry")
            if se and isinstance(se, datetime) and (not te or not isinstance(te, datetime) or se < te):
                target["_expiry"] = se
            if row.get("Plant Name") and row["Plant Name"] not in target["_all_plants"]:
                target["_all_plants"].append(row["Plant Name"])
            if not target.get("Material Group Name") and row.get("Material Group Name"):
                target["Material Group Name"] = row["Material Group Name"]
    
    for row in mat_map.values():
        row["Total Qty"] = (float(row.get("Unrestricted Stock", 0) or 0) + 
                            float(row.get("Stock in Transit", 0) or 0) + 
                            float(row.get("Stock in Quality Inspection", 0) or 0))
        row["Total Value"] = (float(row.get("Value of Unrestricted Stock", 0) or 0) + 
                              float(row.get("Value of Stock in Transit", 0) or 0) + 
                              float(row.get("Value of Stock in Quality Inspection", 0) or 0))
        plants = [p for p in row.get("_all_plants", []) if p]
        row["_plant_list"] = ", ".join(sorted(set(plants))) if plants else (row.get("Plant Name") or "—")
    
    return list(mat_map.values())

# ── PHANTOM TRANSIT ──────────────────────────────────────────────────────

class PhantomTransitDetector:
    """Detects phantom transit rows (no PO + no supplying plant)."""
    
    def __init__(self):
        self.transit_raw = []
    
    def load_transit_data(self, data: List[Dict], allowed_materials: Set[str] = None):
        """Load transit detail data."""
        if not data:
            self.transit_raw = []
            return
        
        rows = []
        for r in data:
            mat = r.get("_st_material", "")
            if allowed_materials and mat not in allowed_materials:
                continue
            rows.append(r)
        self.transit_raw = rows
    
    def is_phantom(self, row: Dict) -> bool:
        """Check if a row is phantom transit."""
        if not self.transit_raw:
            return False
        if float(row.get("Stock in Transit", 0) or 0) <= 0:
            return False
        
        mat = str(row.get("Material", "")).strip()
        plt = str(row.get("Plant", "")).strip().upper()
        
        hits = [r for r in self.transit_raw 
                if r["_st_material"] == mat and 
                (plt == "" or r["_st_plant"].upper() == plt)]
        
        if not hits:
            return True
        return not any(r.get("_st_pur_doc") and r.get("_st_sup_plant") for r in hits)
    
    def get_transit_info(self, material: str, plant_code: str) -> Dict:
        """Get purchasing document and supplying plant for a material/plant."""
        if not self.transit_raw:
            return {"pur_doc": "—", "sup_plant": "—"}
        mat = str(material or "").strip()
        plt = str(plant_code or "").strip().upper()
        hits = [r for r in self.transit_raw 
                if r["_st_material"] == mat and 
                (plt == "" or r["_st_plant"].upper() == plt)]
        if not hits:
            return {"pur_doc": "—", "sup_plant": "—"}
        pur_docs = list(set(r.get("_st_pur_doc", "") for r in hits if r.get("_st_pur_doc")))
        sup_plants = list(set(r.get("_st_sup_plant", "") for r in hits if r.get("_st_sup_plant")))
        return {
            "pur_doc": ", ".join(pur_docs) if pur_docs else "—",
            "sup_plant": ", ".join(sup_plants) if sup_plants else "—",
        }
    
    def get_verified_transit_qty(self, row: Dict) -> float:
        """Get verified (non-phantom) transit quantity."""
        raw = float(row.get("Stock in Transit", 0) or 0)
        if self.is_phantom(row):
            return 0.0
        return raw
    
    def get_verified_transit_val(self, row: Dict) -> float:
        """Get verified (non-phantom) transit value."""
        raw = float(row.get("Value of Stock in Transit", 0) or 0)
        if self.is_phantom(row):
            return 0.0
        return raw
    
    def get_phantom_summary(self, df: List[Dict]) -> Dict:
        """Get summary of phantom transit rows."""
        rows = [r for r in df if self.is_phantom(r)]
        return {
            "count": len(rows),
            "qty": sum(float(r.get("Stock in Transit", 0) or 0) for r in rows),
            "val": sum(float(r.get("Value of Stock in Transit", 0) or 0) for r in rows),
        }

# ── MAPPING TABLE ──────────────────────────────────────────────────────

class MappingTable:
    """Manages material standardization mapping."""
    
    def __init__(self):
        self._map = {}
        self._stats = None
        self._mapped_df = None
    
    def load_from_data(self, data: List[Dict]) -> Dict:
        """Load mapping from data list."""
        if not data:
            return {"success": False, "message": "Mapping data is empty."}
        
        # Find columns
        col_map = {}
        for k in data[0].keys():
            col_map[k.lower().strip()] = k
        
        def get_col(*names):
            for n in names:
                if n.lower() in col_map:
                    return col_map[n.lower()]
            return None
        
        col_source = get_col(
            "material code sorce", "material code source", "material code (source)",
            "source material code", "source code", "mat code source", "mat. code source",
            "source mat code", "source material", "material source", "source"
        )
        col_target = get_col(
            "material code target", "target material code", "target code",
            "mat code target", "mat. code target", "target mat code",
            "target material", "material target", "target"
        )
        col_factor = get_col(
            "conversion factor", "factor", "conv factor", "conversion",
            "conv. factor", "uom factor", "unit factor", "qty factor", "quantity factor"
        )
        col_tgt_desc = get_col(
            "material description (target)", "target description", "target desc",
            "material description target", "target material description", "desc target",
            "description (target)", "description target"
        )
        
        if not col_source or not col_target or not col_factor:
            missing = []
            if not col_source: missing.append("Material Code Source")
            if not col_target: missing.append("Material Code Target")
            if not col_factor: missing.append("Conversion Factor")
            return {"success": False, "message": f"Missing required columns: {', '.join(missing)}"}
        
        new_map = {}
        skipped = 0
        
        for row in data:
            src = str(row.get(col_source, "")).strip()
            tgt = str(row.get(col_target, "")).strip()
            raw_fac = str(row.get(col_factor, "")).strip()
            t_desc = str(row.get(col_tgt_desc, "")).strip() if col_tgt_desc else ""
            
            try:
                factor = float(raw_fac)
            except ValueError:
                skipped += 1
                continue
            
            if not src or not tgt or factor <= 0:
                skipped += 1
                continue
            
            new_map[src.upper()] = {
                "target_code": tgt,
                "target_desc": t_desc,
                "factor": round(factor, 9)
            }
        
        if not new_map:
            return {"success": False, "message": f"No valid mapping rows found ({skipped} skipped)."}
        
        self._map = new_map
        return {"success": True, "count": len(new_map), "skipped": skipped}
    
    def size(self) -> int:
        return len(self._map)
    
    def is_active(self) -> bool:
        return len(self._map) > 0
    
    def get(self, code: str):
        return self._map.get(code.upper())
    
    def apply_to_data(self, data: List[Dict]) -> List[Dict]:
        """Apply mapping to data."""
        if not data or not self._map:
            self._mapped_df = data.copy() if data else []
            self._stats = None
            return self._mapped_df
        
        mapped_count = 0
        total_value = 0
        mapped_value = 0
        
        rows = []
        for row in data:
            src_code = str(row.get("Material", "")).strip().upper()
            entry = self._map.get(src_code)
            total_value += row.get("Total Value", 0)
            
            row_dict = dict(row)
            
            if not entry:
                row_dict.update({
                    "_mapped_material": row.get("Material"),
                    "_mapped_desc": row.get("Material Description"),
                    "_mapping_factor": 1.0,
                    "_is_mapped": False,
                    "_orig_material": row.get("Material"),
                    "_orig_desc": row.get("Material Description"),
                    "_cv_unrestricted": row.get("Unrestricted Stock", 0),
                    "_cv_transit": row.get("Stock in Transit", 0),
                    "_cv_qc": row.get("Stock in Quality Inspection", 0),
                    "_cv_blocked": row.get("Blocked Stock", 0),
                    "_cv_val_unrestricted": row.get("Value of Unrestricted Stock", 0),
                    "_cv_val_transit": row.get("Value of Stock in Transit", 0),
                    "_cv_val_qc": row.get("Value of Stock in Quality Inspection", 0),
                    "_cv_total_qty": row.get("Total Qty", 0),
                    "_cv_total_value": row.get("Total Value", 0),
                })
                rows.append(row_dict)
                continue
            
            f = entry["factor"]
            cv_unrestricted = round((row.get("Unrestricted Stock", 0) or 0) * f, 9)
            cv_transit = round((row.get("Stock in Transit", 0) or 0) * f, 9)
            cv_qc = round((row.get("Stock in Quality Inspection", 0) or 0) * f, 9)
            cv_blocked = round((row.get("Blocked Stock", 0) or 0) * f, 9)
            cv_val_unrestricted = round((row.get("Value of Unrestricted Stock", 0) or 0) * f, 9)
            cv_val_transit = round((row.get("Value of Stock in Transit", 0) or 0) * f, 9)
            cv_val_qc = round((row.get("Value of Stock in Quality Inspection", 0) or 0) * f, 9)
            cv_total_qty = cv_unrestricted + cv_transit + cv_qc
            cv_total_value = cv_val_unrestricted + cv_val_transit + cv_val_qc
            
            mapped_count += 1
            mapped_value += cv_total_value
            
            row_dict.update({
                "_mapped_material": entry["target_code"],
                "_mapped_desc": entry["target_desc"] or row.get("Material Description"),
                "_mapping_factor": f,
                "_is_mapped": True,
                "_orig_material": row.get("Material"),
                "_orig_desc": row.get("Material Description"),
                "_cv_unrestricted": cv_unrestricted,
                "_cv_transit": cv_transit,
                "_cv_qc": cv_qc,
                "_cv_blocked": cv_blocked,
                "_cv_val_unrestricted": cv_val_unrestricted,
                "_cv_val_transit": cv_val_transit,
                "_cv_val_qc": cv_val_qc,
                "_cv_total_qty": cv_total_qty,
                "_cv_total_value": cv_total_value,
            })
            rows.append(row_dict)
        
        self._mapped_df = rows
        value_pct = round((mapped_value / total_value) * 100) if total_value > 0 else 0
        self._stats = {"mapped": mapped_count, "total": len(data), "value_pct": value_pct}
        
        return self._mapped_df
    
    def get_stats(self):
        return self._stats
    
    def get_reconciled_base(self, raw_data: List[Dict]) -> List[Dict]:
        """Returns the base dataset with mapping applied."""
        if self.is_active() and self._mapped_df is not None:
            return self._mapped_df
        return raw_data
    
    def get_mapped_quantity(self, row: Dict, field: str) -> float:
        """Get mapped quantity for a field."""
        if not row.get("_is_mapped", False):
            return float(row.get(field, 0) or 0)
        cv_map = {
            "Unrestricted Stock": "_cv_unrestricted",
            "Stock in Transit": "_cv_transit",
            "Stock in Quality Inspection": "_cv_qc",
            "Blocked Stock": "_cv_blocked"
        }
        cv_field = cv_map.get(field)
        if cv_field:
            return float(row.get(cv_field, 0) or 0)
        return float(row.get(field, 0) or 0)
    
    def get_mapped_value(self, row: Dict, field: str) -> float:
        """Get mapped value for a field."""
        if not row.get("_is_mapped", False):
            return float(row.get(field, 0) or 0)
        cv_map = {
            "Value of Unrestricted Stock": "_cv_val_unrestricted",
            "Value of Stock in Transit": "_cv_val_transit",
            "Value of Stock in Quality Inspection": "_cv_val_qc"
        }
        cv_field = cv_map.get(field)
        if cv_field:
            return float(row.get(cv_field, 0) or 0)
        return float(row.get(field, 0) or 0)
