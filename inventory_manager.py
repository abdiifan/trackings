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
        return v.to_pydatetime().replace(hour