# =============================================================================
# PharmaTrack v2 — inventory_management.py
# Python version of the inventory management application
# =============================================================================

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional, Set, Tuple
import re
import json
from collections import defaultdict
import warnings
warnings.filterwarnings('ignore')

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

def get_mapped_valuation_type(row: Dict) -> str:
    """Extracts valuation type from either Inventory Valuation Type or mapping."""
    vt = get_valuation_type(row)
    if vt == "(None)":
        vt = get_valuation_type(row.get("_orig_row", {}))
    return vt

# ── FORMAT HELPERS ──────────────────────────────────────────────────────

def fmt_etb(v) -> str:
    """Format value as ETB currency."""
    return f"ETB {float(v or 0):,.0f}"

def fmt_qty(v) -> str:
    """Format quantity with commas."""
    return f"{float(v or 0):,.0f}"

def esc_html(s: str) -> str:
    """Escape HTML special characters."""
    if s is None:
        return ""
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

def fmt_local_date(d) -> str:
    """Format date as YYYY-MM-DD (local time)."""
    if not isinstance(d, datetime) and not isinstance(d, pd.Timestamp):
        return ""
    if pd.isna(d):
        return ""
    return d.strftime("%Y-%m-%d")

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

# ── LOOKS LIKE DESCRIPTION ──────────────────────────────────────────────

def looks_like_description(val) -> bool:
    """Returns True if the value looks like free-text description rather than code."""
    if not val:
        return False
    s = str(val).strip()
    if not s:
        return False
    return " " in s or (len(s) > 22 and not re.match(r'^[\w\-\.\/]+$', s))

def get_sibling_code(row: Dict) -> str:
    """Gets the code sibling field for description rendering."""
    if not row:
        return ""
    return str(row.get("Material", row.get("_st_material", row.get("mat", "")))).strip()

# ── MAPPING TABLE ──────────────────────────────────────────────────────

class MappingTable:
    """Manages material standardization mapping."""
    
    def __init__(self):
        self._map = {}
        self._stats = None
        self._mapped_df = None
    
    def load_from_df(self, df: pd.DataFrame) -> Dict:
        """Load mapping from DataFrame."""
        if df.empty:
            return {"success": False, "message": "Mapping file is empty."}
        
        col_map = {}
        for k in df.columns:
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
        
        for _, row in df.iterrows():
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
    
    def apply_to_df(self, df: pd.DataFrame) -> pd.DataFrame:
        """Apply mapping to DataFrame."""
        if df.empty or not self._map:
            self._mapped_df = df.copy()
            self._stats = None
            return self._mapped_df
        
        mapped_count = 0
        total_value = 0
        mapped_value = 0
        
        rows = []
        for _, row in df.iterrows():
            src_code = str(row.get("Material", "")).strip().upper()
            entry = self._map.get(src_code)
            total_value += row.get("Total Value", 0)
            
            row_dict = row.to_dict()
            
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
        
        self._mapped_df = pd.DataFrame(rows)
        value_pct = round((mapped_value / total_value) * 100) if total_value > 0 else 0
        self._stats = {"mapped": mapped_count, "total": len(df), "value_pct": value_pct}
        
        return self._mapped_df
    
    def get_stats(self):
        return self._stats
    
    def get_reconciled_base(self, raw_df: pd.DataFrame) -> pd.DataFrame:
        """Returns the base dataset with mapping applied."""
        if self.is_active() and self._mapped_df is not None:
            return self._mapped_df
        return raw_df
    
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

# ── PHANTOM TRANSIT ──────────────────────────────────────────────────────

class PhantomTransitDetector:
    """Detects phantom transit rows (no PO + no supplying plant)."""
    
    def __init__(self):
        self.transit_raw = []
    
    def load_transit_data(self, df: pd.DataFrame, allowed_materials: Set[str] = None):
        """Load transit detail data."""
        if df.empty:
            self.transit_raw = []
            return
        
        rows = []
        for _, row in df.iterrows():
            mat = str(row.get("Material", "")).strip()
            if allowed_materials and mat not in allowed_materials:
                continue
            rows.append({
                "_st_material": mat,
                "_st_desc": str(row.get("Material Description", "")).strip(),
                "_st_plant": str(row.get("Plant", "")).strip(),
                "_st_plant_name": str(row.get("Name 1", row.get("Plant Name", ""))).strip(),
                "_st_pur_doc": str(row.get("Purchasing Document", "")).strip(),
                "_st_sup_plant": str(row.get("Supplying Plant", "")).strip(),
                "_st_qty": float(row.get("Quantity", row.get("Order Quantity", 0)) or 0),
                "_st_uom": str(row.get("Base Unit of Measure", row.get("Order Unit", ""))).strip(),
                "_st_item": str(row.get("Item", "")).strip(),
                "_st_special_stock": str(row.get("Special Stock", "")).strip(),
            })
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
        return not any(r["_st_pur_doc"] and r["_st_sup_plant"] for r in hits)
    
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
        pur_docs = list(set(r["_st_pur_doc"] for r in hits if r["_st_pur_doc"]))
        sup_plants = list(set(r["_st_sup_plant"] for r in hits if r["_st_sup_plant"]))
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

def aggregate_by_mapped_material(df: List[Dict], mapping: MappingTable) -> List[Dict]:
    """Aggregate rows by mapped material code."""
    if not df:
        return []
    
    use_mapped = mapping.is_active()
    QTY_FIELDS = ["Unrestricted Stock", "Stock in Quality Inspection", "Blocked Stock", "Stock in Transit"]
    VAL_FIELDS = ["Value of Unrestricted Stock", "Value of Stock in Quality Inspection", "Value of Stock in Transit"]
    
    mat_map = {}
    for row in df:
        mat = row.get("_mapped_material" if use_mapped else "Material")
        if not mat:
            continue
        
        if mat not in mat_map:
            mat_map[mat] = dict(row)
            mat_map[mat]["Material"] = mat
            mat_map[mat]["Material Description"] = row.get("_mapped_desc") if use_mapped else row.get("Material Description")
            mat_map[mat]["_mapped_material"] = mat
            mat_map[mat]["_all_plants"] = []
            mat_map[mat]["_orig_codes"] = set()
            for c in QTY_FIELDS:
                mat_map[mat][c] = mapping.get_mapped_quantity(row, c)
            for c in VAL_FIELDS:
                mat_map[mat][c] = mapping.get_mapped_value(row, c)
            if row.get("Plant Name"):
                mat_map[mat]["_all_plants"].append(row["Plant Name"])
            if row.get("_orig_material"):
                mat_map[mat]["_orig_codes"].add(row["_orig_material"])
        else:
            target = mat_map[mat]
            for c in QTY_FIELDS:
                target[c] = float(target.get(c, 0) or 0) + mapping.get_mapped_quantity(row, c)
            for c in VAL_FIELDS:
                target[c] = float(target.get(c, 0) or 0) + mapping.get_mapped_value(row, c)
            te = target.get("_expiry")
            se = row.get("_expiry")
            if se and isinstance(se, datetime) and (not te or not isinstance(te, datetime) or se < te):
                target["_expiry"] = se
            if row.get("Plant Name") and row["Plant Name"] not in target["_all_plants"]:
                target["_all_plants"].append(row["Plant Name"])
            if row.get("_orig_material"):
                target["_orig_codes"].add(row["_orig_material"])
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
        orig_codes = [c for c in row.get("_orig_codes", []) if c and c != row.get("Material")]
        row["_trace_codes"] = ", ".join(orig_codes) if orig_codes else ""
    
    return list(mat_map.values())

# ── SHELF LIFE HELPERS ──────────────────────────────────────────────

_ISL_YEAR_DAYS = 365.25

def compute_isl_metrics(expiry_date: Optional[datetime], posting_date: Optional[datetime]) -> Dict:
    """Compute shelf life metrics from expiry and posting dates."""
    if not expiry_date:
        return {
            "sl_at_receipt_days": None,
            "receipt_flag": "grey",
            "remaining_sl_days": None,
            "ratio": None,
            "flag": "grey",
            "is_expired": False,
            "data_error": False,
        }
    
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    remaining_sl_days = round((expiry_date - today).total_seconds() / 86400)
    is_expired = remaining_sl_days < 0
    
    if is_expired:
        flag = "expired"
        ratio = None
    else:
        ref_window = _ISL_YEAR_DAYS * 2
        r = remaining_sl_days / ref_window
        flag = "green" if r > 0.5 else "yellow" if r >= 0.375 else "red"
        ratio = max(0, min(1, r))
    
    sl_at_receipt_days = None
    receipt_flag = "grey"
    data_error = False
    
    if posting_date:
        sl_at_receipt_days = round((expiry_date - posting_date).total_seconds() / 86400)
        if sl_at_receipt_days <= 0:
            data_error = True
            receipt_flag = "data_error"
        else:
            years = sl_at_receipt_days / _ISL_YEAR_DAYS
            if years < 1.5:
                receipt_flag = "red"
            elif years <= 2:
                receipt_flag = "yellow"
            else:
                receipt_flag = "green"
    
    return {
        "sl_at_receipt_days": sl_at_receipt_days,
        "receipt_flag": receipt_flag,
        "remaining_sl_days": remaining_sl_days,
        "ratio": ratio,
        "flag": flag,
        "is_expired": is_expired,
        "data_error": data_error,
    }

# ── INCOMING SHELF LIFE ──────────────────────────────────────────────

class IncomingShelfLife:
    """Manages incoming goods shelf life analysis."""
    
    def __init__(self):
        self.raw = []
        self.raw_all = []
        self.mapping = MappingTable()
    
    def set_mapping(self, mapping: MappingTable):
        self.mapping = mapping
    
    def load_from_df(self, df: pd.DataFrame) -> Dict:
        """Load incoming goods data from DataFrame."""
        if df.empty:
            return {"success": False, "message": "File is empty."}
        
        ALLOWED_VT = ["ZME", "ZMS", "ZLC"]
        
        rows = []
        for _, row in df.iterrows():
            plant = str(row.get("Plant", "")).strip().upper()
            if plant != "HO01":
                continue
            vt = self._extract_vt(row)
            if vt not in ALLOWED_VT:
                continue
            
            rows.append({
                "Material": str(row.get("Material", "")).strip(),
                "Material Description": str(row.get("Material Description", "")).strip(),
                "Batch": str(row.get("Batch", "")).strip(),
                "Plant": plant,
                "Storage Location": str(row.get("Storage Location", "")).strip(),
                "Material Document": str(row.get("Material Document", row.get("GR Document", ""))).strip(),
                "Quantity": float(row.get("Quantity", row.get("Posted Quantity", row.get("GR Quantity", 0))) or 0),
                "_posting_date": parse_posting_date(row.get("Posting Date")),
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
        
        self.raw_all = rows
        self._cross_match_inventory()
        
        return {
            "success": True,
            "loaded": len(rows),
            "matched": len(self.raw),
        }
    
    def _extract_vt(self, row) -> str:
        raw = str(row.get("Valuation Type", row.get("Inventory Valuation Type", ""))).strip()
        if not raw:
            return ""
        i = raw.rfind("_")
        if i == -1 or i == len(raw) - 1:
            return raw.upper()
        return raw[i + 1:].upper()
    
    def _cross_match_inventory(self):
        """Cross-match incoming goods against inventory."""
        if not self.raw_all:
            self.raw = []
            return
        
        # Build inventory lookup
        # For now, use stored inventory data via the mapping
        # In a full implementation, this would use the main inventory DataFrame
        
        # For each row, compute SL metrics
        for r in self.raw_all:
            expiry = r.get("_inv_expiry_date")
            posting = r.get("_posting_date")
            metrics = compute_isl_metrics(expiry, posting)
            r.update(metrics)
            r["_in_inventory"] = expiry is not None
        
        # Group by Material+Batch
        self.raw = self._group_by_material_batch([r for r in self.raw_all if r["_in_inventory"]])
    
    def _group_by_material_batch(self, rows: List[Dict]) -> List[Dict]:
        """Group rows by Material+Batch, keeping the latest posting date."""
        groups = {}
        for r in rows:
            mat = str(r.get("Material", "")).strip().upper()
            batch = str(r.get("Batch", "")).strip().upper()
            key = f"{mat}||{batch}"
            if key not in groups:
                groups[key] = []
            groups[key].append(r)
        
        result = []
        for group in groups.values():
            ref = group[0]
            for r in group[1:]:
                a = ref["_posting_date"].timestamp() if ref["_posting_date"] else -float("inf")
                b = r["_posting_date"].timestamp() if r["_posting_date"] else -float("inf")
                if b > a:
                    ref = r
            total_qty = sum(self._get_row_qty(r) for r in group)
            result.append({**ref, "_grouped_qty": total_qty, "_receipt_count": len(group)})
        return result
    
    def _get_row_qty(self, r: Dict) -> float:
        candidates = ["Quantity", "Posted Quantity", "Quantity in Unit of Entry", "GR Quantity", "Order Quantity", "Total Qty"]
        for c in candidates:
            if c in r:
                try:
                    return float(r[c] or 0)
                except:
                    pass
        return 0
    
    def get_filtered(self, date: str = "", val_type: str = "", sloc: str = "", 
                     mg: str = "", materials: List[str] = None) -> List[Dict]:
        """Get filtered incoming goods rows."""
        mat_codes = [v.split(" — ")[0].strip().lower() for v in (materials or [])]
        result = []
        for r in self.raw:
            if date:
                rd = fmt_local_date(r.get("_posting_date"))
                if rd != date:
                    continue
            if val_type and r.get("_vt") != val_type:
                continue
            if sloc and str(r.get("Storage Location", "")).strip() != sloc:
                continue
            if mg and r.get("_inv_material_group") != mg:
                continue
            if mat_codes:
                mat = str(r.get("Material", "")).strip().lower()
                if mat not in mat_codes:
                    continue
            result.append(r)
        return result

# ── PROCESS INVENTORY FILE ──────────────────────────────────────────────

def process_inventory_file(df: pd.DataFrame, mapping: MappingTable, 
                           phantom_detector: PhantomTransitDetector = None) -> Tuple[List[Dict], List[Dict]]:
    """Process the inventory Excel file."""
    if df.empty:
        return [], []
    
    trimmed = []
    for _, row in df.iterrows():
        r = {}
        for k, v in row.items():
            r[str(k).strip()] = v
        trimmed.append(r)
    
    if not trimmed:
        return [], []
    
    # Filter out excluded rows
    filtered = []
    for r in trimmed:
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
    
    raw_df = filtered
    
    # Apply mapping
    mapped_df = mapping.apply_to_df(pd.DataFrame(filtered))
    if mapped_df is not None and not mapped_df.empty:
        raw_df = mapped_df.to_dict('records')
    
    # Apply phantom transit detection
    if phantom_detector:
        for r in raw_df:
            if phantom_detector.is_phantom(r):
                r["_phantom_transit_qty"] = float(r.get("Stock in Transit", 0) or 0)
                r["_phantom_transit_val"] = float(r.get("Value of Stock in Transit", 0) or 0)
            else:
                r["_phantom_transit_qty"] = 0
                r["_phantom_transit_val"] = 0
            r["Total Value"] = (r.get("Value of Unrestricted Stock", 0) + 
                                (float(r.get("Value of Stock in Transit", 0) or 0) - r["_phantom_transit_val"]) + 
                                r.get("Value of Stock in Quality Inspection", 0))
            r["Total Qty"] = (r.get("Unrestricted Stock", 0) + 
                              (float(r.get("Stock in Transit", 0) or 0) - r["_phantom_transit_qty"]) + 
                              r.get("Stock in Quality Inspection", 0))
    
    return raw_df, []

# ── FILTER FUNCTIONS ──────────────────────────────────────────────────

def apply_page_filter(df: List[Dict], page: str, filters: Dict, mapping: MappingTable) -> List[Dict]:
    """Apply page-level filters to the data."""
    if not df:
        return []
    
    f = filters.get(page, {})
    plants = f.get("plants", [])
    mgs = f.get("mgs", [])
    val_types = f.get("val_types", [])
    materials = [v.split(" — ")[0].strip().lower() for v in f.get("materials", [])]
    
    result = []
    for r in df:
        if is_non_medical_code(r.get("Material")):
            continue
        if is_non_medical_group(r.get("Material Group Name")):
            continue
        if is_project_stock_description(r.get("Special Stock Type Description")):
            continue
        if is_excluded_storage_location(r.get("Storage Location")):
            continue
        special_stock = str(r.get("Special Stock Type", "")).strip().upper()
        if special_stock in ("Q", "W"):
            continue
        if str(r.get("Inventory Valuation Type", "")).strip() == "":
            continue
        if plants and r.get("Plant Name") not in plants:
            continue
        if mgs and r.get("Material Group Name") not in mgs:
            continue
        if val_types and get_valuation_type(r) not in val_types:
            continue
        if materials:
            mat = str(r.get("Material", "")).strip().lower()
            if mat not in materials:
                continue
        result.append(r)
    return result

# ── KPI CALCULATIONS ─────────────────────────────────────────────────

def calculate_kpis(df: List[Dict], mapping: MappingTable, phantom: PhantomTransitDetector) -> Dict:
    """Calculate dashboard KPIs."""
    if not df:
        return {
            "total_value": 0, "total_qty": 0,
            "transit_val": 0, "transit_qty": 0,
            "qc_val": 0, "qc_qty": 0,
            "avail_val": 0, "avail_qty": 0,
            "unique_materials": 0,
        }
    
    avail_val = sum(mapping.get_mapped_value(r, "Value of Unrestricted Stock") for r in df)
    avail_qty = sum(mapping.get_mapped_quantity(r, "Unrestricted Stock") for r in df)
    transit_val = sum(phantom.get_verified_transit_val(r) for r in df)
    transit_qty = sum(phantom.get_verified_transit_qty(r) for r in df)
    qc_val = sum(mapping.get_mapped_value(r, "Value of Stock in Quality Inspection") for r in df)
    qc_qty = sum(mapping.get_mapped_quantity(r, "Stock in Quality Inspection") for r in df)
    
    return {
        "total_value": avail_val + transit_val + qc_val,
        "total_qty": avail_qty + transit_qty + qc_qty,
        "transit_val": transit_val,
        "transit_qty": transit_qty,
        "qc_val": qc_val,
        "qc_qty": qc_qty,
        "avail_val": avail_val,
        "avail_qty": avail_qty,
        "unique_materials": len(set(r.get("_mapped_material", r.get("Material")) for r in df if r.get("Material"))),
    }

# ── RENDER TABLE ────────────────────────────────────────────────────

def build_table(rows: List[Dict], cols: List[Dict], row_class_func=None) -> str:
    """Build HTML table from data."""
    if not rows:
        return '<div class="alert-info">No data to display.</div>'
    
    thead = "<thead><tr>"
    for c in cols:
        thead += f"<th>{esc_html(c.get('label', ''))}</th>"
    thead += "</tr></thead>"
    
    tbody = "<tbody>"
    for row in rows:
        cls = row_class_func(row) if row_class_func else ""
        tbody += f'<tr class="{cls}">'
        for c in cols:
            val = row.get(c.get("key", ""), "")
            if c.get("fmt"):
                val = c["fmt"](val, row)
            if not c.get("raw", False):
                val = esc_html(str(val))
            cell_cls = c.get("cell_class", "")
            tbody += f'<td class="{cell_cls}">{val}</td>'
        tbody += "</tr>"
    tbody += "</tbody>"
    
    return f'<div class="tbl-wrap"><table>{thead}{tbody}</table></div>'

# ── EXPORT HELPERS ──────────────────────────────────────────────────

def download_csv(data: List[Dict], cols: List[Dict], filename: str) -> str:
    """Generate CSV content from data."""
    header = ",".join(esc_html(c.get("label", "")) for c in cols)
    rows = []
    for row in data:
        row_vals = []
        for c in cols:
            val = row.get(c.get("key", ""), "")
            if c.get("fmt"):
                val = c["fmt"](val, row)
            val = str(val)
            if "," in val or '"' in val or "\n" in val:
                val = f'"{val.replace('"', '""')}"'
            elif val and val[0] in "=+-@":
                val = f"'{val}"
            row_vals.append(val)
        rows.append(",".join(row_vals))
    return "\uFEFF" + header + "\n" + "\n".join(rows)

def download_excel(data: List[Dict], cols: List[Dict], filename: str) -> pd.DataFrame:
    """Create Excel DataFrame from data."""
    rows = []
    for row in data:
        row_vals = {}
        for c in cols:
            val = row.get(c.get("key", ""), "")
            if c.get("fmt"):
                val = c["fmt"](val, row)
            row_vals[c.get("label", "")] = val
        rows.append(row_vals)
    return pd.DataFrame(rows)

# ── MAIN PROCESSING CLASS ──────────────────────────────────────────

class InventoryManager:
    """Main inventory management class."""
    
    def __init__(self):
        self.raw_df = []
        self.filt_df = []
        self.mapping = MappingTable()
        self.phantom = PhantomTransitDetector()
        self.incoming = IncomingShelfLife()
        self.page_filters = {
            "dashboard": {"plants": [], "mgs": [], "val_types": []},
            "transit": {"plants": [], "mgs": [], "val_types": [], "materials": []},
            "expiry": {"plants": [], "mgs": [], "val_types": [], "materials": []},
            "qc": {"plants": [], "mgs": [], "val_types": [], "materials": []},
            "branch": {"mgs": [], "val_types": [], "materials": []},
            "flow": {"plants": [], "mgs": [], "val_types": [], "materials": []},
            "incoming": {},
            "concentration": {"mgs": [], "val_types": []},
        }
        self.current_page = "dashboard"
        self._last_spread_drilldown = None
    
    def load_inventory(self, df: pd.DataFrame) -> Dict:
        """Load inventory data from Excel."""
        raw, _ = process_inventory_file(df, self.mapping, self.phantom)
        self.raw_df = raw
        self.filt_df = raw
        self._reset_page_filters()
        self.incoming.set_mapping(self.mapping)
        return {"success": True, "count": len(raw)}
    
    def load_transit(self, df: pd.DataFrame) -> Dict:
        """Load transit detail data."""
        if self.raw_df:
            allowed = set(str(r.get("Material", "")).strip() for r in self.raw_df if r.get("Material"))
        else:
            allowed = None
        self.phantom.load_transit_data(df, allowed)
        return {"success": True, "count": len(self.phantom.transit_raw)}
    
    def load_mapping(self, df: pd.DataFrame) -> Dict:
        """Load material standardization mapping."""
        result = self.mapping.load_from_df(df)
        if result.get("success"):
            self.mapping.apply_to_df(pd.DataFrame(self.raw_df) if self.raw_df else pd.DataFrame())
            self.incoming.set_mapping(self.mapping)
        return result
    
    def load_incoming(self, df: pd.DataFrame) -> Dict:
        """Load incoming goods data."""
        self.incoming.set_mapping(self.mapping)
        return self.incoming.load_from_df(df)
    
    def _reset_page_filters(self):
        for page, f in self.page_filters.items():
            if "plants" in f:
                f["plants"] = []
            if "mgs" in f:
                f["mgs"] = []
            if "val_types" in f:
                f["val_types"] = []
            if "materials" in f:
                f["materials"] = []
    
    def apply_page_filter(self, page: str) -> List[Dict]:
        """Apply filters for a specific page."""
        if not self.raw_df:
            return []
        base = self.mapping.get_reconciled_base(pd.DataFrame(self.raw_df))
        if isinstance(base, pd.DataFrame):
            base = base.to_dict('records')
        return apply_page_filter(base, page, self.page_filters, self.mapping)
    
    def render_dashboard(self) -> Dict:
        """Render dashboard data."""
        df = self.apply_page_filter("dashboard")
        kpis = calculate_kpis(df, self.mapping, self.phantom)
        phantom_summary = self.phantom.get_phantom_summary(df)
        
        # Plant aggregation
        plant_agg = group_by(df, "Plant Name", [
            ("unrestricted", "Value of Unrestricted Stock"),
            ("transit", "Value of Stock in Transit"),
            ("qc", "Value of Stock in Quality Inspection"),
            ("unrestricted_qty", "Unrestricted Stock"),
            ("transit_qty", "Stock in Transit"),
            ("qc_qty", "Stock in Quality Inspection"),
        ])
        plant_agg = sort_by(plant_agg, "unrestricted", asc=False)
        
        # Expiry risk by material group
        now = datetime.now()
        cut_3mo = now + timedelta(days=90)
        cut_6mo = now + timedelta(days=180)
        
        mg_risk = {}
        for r in df:
            expiry = r.get("_expiry")
            if not isinstance(expiry, datetime):
                continue
            if float(r.get("Unrestricted Stock", 0) or 0) <= 0:
                continue
            grp = r.get("Material Group Name", "(Blank)")
            mat = r.get("_mapped_material", r.get("Material"))
            if grp not in mg_risk:
                mg_risk[grp] = {"critical": set(), "high": set()}
            if expiry >= now and expiry <= cut_3mo:
                mg_risk[grp]["critical"].add(mat)
            elif expiry > cut_3mo and expiry <= cut_6mo:
                mg_risk[grp]["high"].add(mat)
        
        mg_risk_rows = []
        for grp, sets in mg_risk.items():
            if len(sets["critical"]) + len(sets["high"]) > 0:
                mg_risk_rows.append({
                    "group": grp,
                    "critical": len(sets["critical"]),
                    "high": len(sets["high"]),
                    "total": len(sets["critical"]) + len(sets["high"]),
                })
        mg_risk_rows = sorted(mg_risk_rows, key=lambda x: x["total"], reverse=True)[:12]
        
        return {
            "kpis": kpis,
            "phantom": phantom_summary,
            "plant_agg": plant_agg,
            "mg_risk": mg_risk_rows,
            "total_rows": len(df),
        }
    
    def render_transit(self) -> Dict:
        """Render transit data."""
        df = self.apply_page_filter("transit")
        df = [r for r in df if r.get("Stock in Transit", 0) > 0 and r.get("Value of Stock in Transit", 0) > 0]
        df = [r for r in df if not self.phantom.is_phantom(r)]
        
        if not df:
            return {"rows": [], "kpis": {"total_val": 0, "total_qty": 0, "unique_mats": 0}}
        
        total_val = sum(self.mapping.get_mapped_value(r, "Value of Stock in Transit") for r in df)
        total_qty = sum(self.mapping.get_mapped_quantity(r, "Stock in Transit") for r in df)
        unique_mats = len(set(r.get("_mapped_material", r.get("Material")) for r in df))
        
        rows = []
        for r in sorted(df, key=lambda x: x.get("Value of Stock in Transit", 0), reverse=True):
            info = self.phantom.get_transit_info(r.get("Material"), r.get("Plant"))
            val = r.get("Value of Stock in Transit", 0)
            if val > 100000:
                status = "<span class='badge badge-red'>Critical</span>"
            elif val > 50000:
                status = "<span class='badge badge-amber'>High</span>"
            elif val > 10000:
                status = "<span class='badge badge-amber'>Medium</span>"
            else:
                status = "<span class='badge badge-green'>Low</span>"
            rows.append({
                **r,
                "_pur_doc": info["pur_doc"],
                "_sup_plant": info["sup_plant"],
                "_status": status,
            })
        
        # Plant chart
        plant_agg = group_by(df, "Plant Name", [
            ("val", "Value of Stock in Transit"),
            ("qty", "Stock in Transit"),
        ])
        plant_agg = sort_by(plant_agg, "val", asc=False)
        
        return {
            "rows": rows,
            "kpis": {"total_val": total_val, "total_qty": total_qty, "unique_mats": unique_mats},
            "plant_agg": plant_agg,
        }
    
    def render_expiry(self, months: int = 6) -> Dict:
        """Render expiry watchlist data."""
        df = self.apply_page_filter("expiry")
        today = datetime.now()
        cutoff = today + timedelta(days=months * 30)
        
        valid = [r for r in df if isinstance(r.get("_expiry"), datetime)]
        expiring = [r for r in valid if r["_expiry"] >= today and r["_expiry"] <= cutoff 
                   and (r.get("Unrestricted Stock", 0) or 0) > 0
                   and (r.get("Value of Unrestricted Stock", 0) or 0) > 0]
        expired = [r for r in valid if r["_expiry"] < today and (r.get("Unrestricted Stock", 0) or 0) > 0]
        
        if not expiring:
            return {"rows": [], "expired_rows": [], "kpis": {"expiring": 0, "expired": 0, "at_risk_val": 0, "at_risk_qty": 0}}
        
        expiring_uniq = len(set(r.get("_mapped_material", r.get("Material")) for r in expiring))
        expired_uniq = len(set(r.get("_mapped_material", r.get("Material")) for r in expired))
        at_risk_val = sum(self.mapping.get_mapped_value(r, "Value of Unrestricted Stock") for r in expiring)
        at_risk_qty = sum(self.mapping.get_mapped_quantity(r, "Unrestricted Stock") for r in expiring)
        
        # Timeline
        month_map = {}
        val_map = {}
        for r in expiring:
            key = r["_expiry"].strftime("%Y-%m")
            month_map[key] = month_map.get(key, 0) + 1
            val_map[key] = val_map.get(key, 0) + r.get("Value of Unrestricted Stock", 0)
        
        months_sorted = sorted(month_map.keys())
        
        expired_rows = []
        for r in expired:
            expired_rows.append({
                **r,
                "_expiry_str": fmt_local_date(r["_expiry"]),
            })
        
        return {
            "rows": expiring,
            "expired_rows": expired_rows,
            "kpis": {"expiring": expiring_uniq, "expired": expired_uniq, "at_risk_val": at_risk_val, "at_risk_qty": at_risk_qty},
            "timeline": {"months": months_sorted, "counts": [month_map[m] for m in months_sorted], "values": [val_map[m] for m in months_sorted]},
        }
    
    def render_qc(self) -> Dict:
        """Render quality inspection data."""
        raw = apply_page_filter(self.raw_df, "qc", self.page_filters, self.mapping)
        raw = [r for r in raw if (r.get("Stock in Quality Inspection", 0) or 0) > 0]
        
        if not raw:
            return {"rows": [], "kpis": {"total_val": 0, "total_qty": 0, "unique_mats": 0}}
        
        df = aggregate_by_mapped_material(raw, self.mapping)
        df = [r for r in df if (r.get("Stock in Quality Inspection", 0) or 0) > 0]
        
        total_val = sum(self.mapping.get_mapped_value(r, "Value of Stock in Quality Inspection") for r in raw)
        total_qty = sum(self.mapping.get_mapped_quantity(r, "Stock in Quality Inspection") for r in raw)
        unique_mats = len(set(r.get("_mapped_material", r.get("Material")) for r in raw))
        
        rows = []
        for r in sorted(df, key=lambda x: x.get("Value of Stock in Quality Inspection", 0), reverse=True):
            rows.append({
                **r,
                "_expiry_str": fmt_local_date(r.get("_expiry")),
            })
        
        plant_agg = group_by(raw, "Plant Name", [
            ("val", "Value of Stock in Quality Inspection"),
            ("qty", "Stock in Quality Inspection"),
        ])
        plant_agg = sort_by(plant_agg, "val", asc=False)
        
        return {
            "rows": rows,
            "kpis": {"total_val": total_val, "total_qty": total_qty, "unique_mats": unique_mats},
            "plant_agg": plant_agg,
        }
    
    def render_branch_comparison(self) -> Dict:
        """Render branch comparison data."""
        base_df = self.apply_page_filter("branch")
        if not base_df:
            return {"branches": [], "central": "", "material_data": []}
        
        plants = list(set(str(r.get("Plant", "")).upper() for r in base_df))
        
        # Find central branch
        central_name = ""
        central_info_el = ""
        if "HO01" in plants:
            central_name = next((r.get("Plant Name") for r in base_df if str(r.get("Plant", "")).upper() == "HO01"), "HO01")
        else:
            totals = {}
            for r in base_df:
                p = r.get("Plant Name")
                totals[p] = totals.get(p, 0) + r.get("Total Value", 0)
            if totals:
                central_name = max(totals.items(), key=lambda x: x[1])[0]
                central_info_el = f"ℹ️ HO01 not found — using <b>{esc_html(central_name)}</b> as central branch."
        
        # Branch aggregation
        agg_map = {}
        agg_mat_sets = {}
        for r in base_df:
            k = r.get("Plant Name")
            if not k:
                continue
            if k not in agg_map:
                agg_map[k] = {
                    "PlantName": k,
                    "Plant": r.get("Plant"),
                    "TotalValue": 0,
                    "Unrestricted": 0,
                    "Transit": 0,
                    "QC": 0,
                    "UnrestrictedQty": 0,
                    "TransitQty": 0,
                    "QCQty": 0,
                    "Items": 0,
                }
                agg_mat_sets[k] = set()
            
            agg_map[k]["TotalValue"] += (self.mapping.get_mapped_value(r, "Value of Unrestricted Stock") +
                                         self.phantom.get_verified_transit_val(r) +
                                         self.mapping.get_mapped_value(r, "Value of Stock in Quality Inspection"))
            agg_map[k]["Unrestricted"] += self.mapping.get_mapped_value(r, "Value of Unrestricted Stock")
            agg_map[k]["Transit"] += self.phantom.get_verified_transit_val(r)
            agg_map[k]["QC"] += self.mapping.get_mapped_value(r, "Value of Stock in Quality Inspection")
            agg_map[k]["UnrestrictedQty"] += self.mapping.get_mapped_quantity(r, "Unrestricted Stock")
            agg_map[k]["TransitQty"] += self.phantom.get_verified_transit_qty(r)
            agg_map[k]["QCQty"] += self.mapping.get_mapped_quantity(r, "Stock in Quality Inspection")
            mat_key = r.get("_mapped_material") if self.mapping.is_active() else r.get("Material")
            if mat_key:
                agg_mat_sets[k].add(str(mat_key))
        
        for k in agg_map:
            agg_map[k]["Items"] = len(agg_mat_sets.get(k, set()))
        
        branches = list(agg_map.values())
        others = [b["PlantName"] for b in branches if b["PlantName"] != central_name]
        
        return {
            "branches": branches,
            "central": central_name,
            "others": others,
            "central_info": central_info_el,
        }
    
    def render_flow(self) -> Dict:
        """Render inventory flow data."""
        df = self.apply_page_filter("flow")
        
        avail_val = sum(self.mapping.get_mapped_value(r, "Value of Unrestricted Stock") for r in df)
        avail_qty = sum(self.mapping.get_mapped_quantity(r, "Unrestricted Stock") for r in df)
        transit_val = sum(self.phantom.get_verified_transit_val(r) for r in df)
        transit_qty = sum(self.phantom.get_verified_transit_qty(r) for r in df)
        qc_val = sum(self.mapping.get_mapped_value(r, "Value of Stock in Quality Inspection") for r in df)
        qc_qty = sum(self.mapping.get_mapped_quantity(r, "Stock in Quality Inspection") for r in df)
        
        reorder_items = [r for r in df if (r.get("Unrestricted Stock", 0) or 0) == 0 and (
            (r.get("Stock in Transit", 0) > 0 and not self.phantom.is_phantom(r)) or
            r.get("Stock in Quality Inspection", 0) > 0
        )]
        
        reorder_rows = []
        for r in reorder_items:
            info = self.phantom.get_transit_info(r.get("Material"), r.get("Plant"))
            transit_q = self.phantom.get_verified_transit_qty(r)
            qc_q = self.mapping.get_mapped_quantity(r, "Stock in Quality Inspection")
            if transit_q > 0 and qc_q > 0:
                alert = "<span class='badge badge-red'>Transit+QC</span>"
            elif transit_q > 0:
                alert = "<span class='badge badge-amber'>Awaiting Transit</span>"
            else:
                alert = "<span class='badge badge-amber'>Awaiting QC Release</span>"
            reorder_rows.append({
                **r,
                "_pur_doc": info["pur_doc"],
                "_sup_plant": info["sup_plant"],
                "_alert": alert,
            })
        
        # Stock levels by plant
        plant_stock = {}
        for r in df:
            k = r.get("Plant Name", "(Blank)")
            if k not in plant_stock:
                plant_stock[k] = {"Plant Name": k, "avail": 0, "transit": 0, "qc": 0}
            plant_stock[k]["avail"] += self.mapping.get_mapped_quantity(r, "Unrestricted Stock")
            plant_stock[k]["transit"] += self.phantom.get_verified_transit_qty(r)
            plant_stock[k]["qc"] += self.mapping.get_mapped_quantity(r, "Stock in Quality Inspection")
        
        plant_stock_list = sort_by(list(plant_stock.values()), "avail", asc=False)
        
        # Transfer rows
        transfer_rows = []
        for r in df:
            if r.get("Stock in Transit", 0) > 0 and not self.phantom.is_phantom(r):
                info = self.phantom.get_transit_info(r.get("Material"), r.get("Plant"))
                transfer_rows.append({
                    **r,
                    "_pur_doc": info["pur_doc"],
                    "_sup_plant": info["sup_plant"],
                })
        transfer_rows = sort_by(transfer_rows, "Value of Stock in Transit", asc=False)
        
        return {
            "kpis": {
                "total_val": avail_val + transit_val + qc_val,
                "total_qty": avail_qty + transit_qty + qc_qty,
                "avail_val": avail_val,
                "avail_qty": avail_qty,
                "transit_val": transit_val,
                "transit_qty": transit_qty,
                "qc_val": qc_val,
                "qc_qty": qc_qty,
                "reorder_count": len(reorder_items),
            },
            "reorder_rows": reorder_rows,
            "plant_stock": plant_stock_list,
            "transfer_rows": transfer_rows,
        }
    
    def render_concentration(self) -> Dict:
        """Render stock concentration data."""
        f = self.page_filters.get("concentration", {})
        mgs = f.get("mgs", [])
        val_types = f.get("val_types", [])
        use_mapped = self.mapping.is_active()
        
        base = self.mapping.get_reconciled_base(pd.DataFrame(self.raw_df))
        if isinstance(base, pd.DataFrame):
            base = base.to_dict('records')
        
        df = [r for r in base if
            not is_non_medical_code(r.get("Material")) and
            not is_non_medical_group(r.get("Material Group Name")) and
            not is_project_stock_description(r.get("Special Stock Type Description")) and
            not is_excluded_storage_location(r.get("Storage Location")) and
            str(r.get("Special Stock Type", "")).strip().upper() not in ("Q", "W") and
            str(r.get("Inventory Valuation Type", "")).strip() != "" and
            (not mgs or r.get("Material Group Name") in mgs) and
            (not val_types or get_valuation_type(r) in val_types)
        ]
        
        if not df:
            return {"materials": [], "plant_distribution": [], "sole": [], "few": [], "spread": [], "wide": []}
        
        # Plant value aggregation
        plant_val = {}
        for r in df:
            k = r.get("Plant Name", "(Blank)")
            plant_val[k] = plant_val.get(k, 0) + self.mapping.get_mapped_value(r, "Value of Unrestricted Stock")
        total_val = sum(plant_val.values())
        plant_dist = [{"name": k, "val": v, "pct": (v / total_val * 100) if total_val > 0 else 0} 
                      for k, v in plant_val.items()]
        plant_dist = sorted(plant_dist, key=lambda x: x["val"], reverse=True)
        
        # Per-material aggregation
        mat_plant_map = {}
        for r in df:
            mat = r.get("_mapped_material") if use_mapped else r.get("Material")
            desc = r.get("_mapped_desc") if use_mapped else r.get("Material Description", "")
            plant = r.get("Plant Name", "(Blank)")
            orig = r.get("_orig_material", r.get("Material"))
            if not mat:
                continue
            if mat not in mat_plant_map:
                mat_plant_map[mat] = {
                    "desc": desc or "",
                    "plants": {},
                    "total_qty": 0,
                    "total_val": 0,
                    "orig_codes": set(),
                }
            qty = self.mapping.get_mapped_quantity(r, "Unrestricted Stock")
            val = self.mapping.get_mapped_value(r, "Value of Unrestricted Stock")
            if plant not in mat_plant_map[mat]["plants"]:
                mat_plant_map[mat]["plants"][plant] = {"qty": 0, "val": 0}
            mat_plant_map[mat]["plants"][plant]["qty"] += qty
            mat_plant_map[mat]["plants"][plant]["val"] += val
            mat_plant_map[mat]["total_qty"] += qty
            mat_plant_map[mat]["total_val"] += val
            if orig and orig != mat:
                mat_plant_map[mat]["orig_codes"].add(orig)
        
        # Concentration classification
        mat_conc = []
        for mat, info in mat_plant_map.items():
            plant_count = len(info["plants"])
            if plant_count == 0:
                continue
            top_plant = max(info["plants"].items(), key=lambda x: x[1]["qty"])
            top_qty = top_plant[1]["qty"]
            top_val = top_plant[1]["val"]
            pct_qty = (top_qty / info["total_qty"] * 100) if info["total_qty"] > 0 else 0
            pct_val = (top_val / info["total_val"] * 100) if info["total_val"] > 0 else 0
            mat_conc.append({
                "mat": mat,
                "desc": info["desc"],
                "plant_count": plant_count,
                "top_plant_name": top_plant[0],
                "top_qty": top_qty,
                "top_val": top_val,
                "pct_qty": pct_qty,
                "pct_val": pct_val,
                "total_qty": info["total_qty"],
                "total_val": info["total_val"],
                "orig_codes": ", ".join(sorted(info["orig_codes"])),
            })
        
        mat_conc = [r for r in mat_conc if r["total_qty"] > 0]
        
        # Band classification
        sole = [r for r in mat_conc if r["pct_qty"] >= 80]
        few = [r for r in mat_conc if r["pct_qty"] < 80 and 2 <= r["plant_count"] <= 4]
        spread = [r for r in mat_conc if r["pct_qty"] < 80 and 5 <= r["plant_count"] <= 8]
        wide = [r for r in mat_conc if r["pct_qty"] < 80 and r["plant_count"] > 8]
        
        # Spread distribution
        spread_count = {}
        for r in mat_conc:
            k = r["plant_count"]
            spread_count[k] = spread_count.get(k, 0) + 1
        
        return {
            "materials": mat_conc,
            "plant_distribution": plant_dist,
            "sole": sole,
            "few": few,
            "spread": spread,
            "wide": wide,
            "spread_count": spread_count,
            "total_val": total_val,
            "total_mats": len(mat_conc),
            "unique_plants": len(plant_dist),
        }


# ── USAGE EXAMPLE ──────────────────────────────────────────────────

def main():
    """Example usage of the InventoryManager."""
    manager = InventoryManager()
    
    # Load inventory data
    # df = pd.read_excel("inventory.xlsx")
    # result = manager.load_inventory(df)
    # print(f"Loaded {result['count']} records")
    
    # Load mapping
    # mapping_df = pd.read_excel("mapping.xlsx")
    # result = manager.load_mapping(mapping_df)
    # print(f"Loaded {result.get('count', 0)} mapping rules")
    
    # Load transit data
    # transit_df = pd.read_excel("transit.xlsx")
    # result = manager.load_transit(transit_df)
    # print(f"Loaded {result['count']} transit records")
    
    # Load incoming goods
    # incoming_df = pd.read_excel("incoming.xlsx")
    # result = manager.load_incoming(incoming_df)
    # print(f"Loaded {result.get('loaded', 0)} incoming records")
    
    # Render dashboard
    # dashboard = manager.render_dashboard()
    # print(f"Total inventory value: {fmt_etb(dashboard['kpis']['total_value'])}")
    
    print("InventoryManager initialized. Load data using the methods above.")
    return manager


if __name__ == "__main__":
    manager = main()