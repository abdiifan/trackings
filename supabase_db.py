# =============================================================================
# supabase_db.py - Supabase Database Operations Module
# =============================================================================

import streamlit as st
from supabase import Client
from typing import List, Dict, Optional, Any, Tuple
import pandas as pd
from datetime import datetime
import json

# ── TABLE SCHEMAS ───────────────────────────────────────────────────────────

TABLE_SCHEMAS = {
    "inventory": {
        "user_id": "uuid",
        "material": "text",
        "material_description": "text",
        "plant": "text",
        "plant_name": "text",
        "storage_location": "text",
        "storage_location_description": "text",
        "special_stock_type": "text",
        "special_stock_type_description": "text",
        "unrestricted_stock": "numeric",
        "stock_in_quality_inspection": "numeric",
        "blocked_stock": "numeric",
        "batch": "text",
        "inventory_valuation_type": "text",
        "material_group_name": "text",
        "shelf_life_expiration_date": "date",
        "stock_in_transit": "numeric",
        "value_of_stock_in_quality_inspection": "numeric",
        "value_of_stock_in_transit": "numeric",
        "value_of_unrestricted_stock": "numeric",
        "total_value": "numeric",
        "total_qty": "numeric",
        "created_at": "timestamptz",
        "updated_at": "timestamptz"
    },
    "mapping": {
        "user_id": "uuid",
        "source_code": "text",
        "target_code": "text",
        "target_description": "text",
        "conversion_factor": "numeric",
        "created_at": "timestamptz",
        "updated_at": "timestamptz"
    },
    "transit": {
        "user_id": "uuid",
        "material": "text",
        "material_description": "text",
        "plant": "text",
        "plant_name": "text",
        "purchasing_document": "text",
        "item": "text",
        "supplying_plant": "text",
        "special_stock": "text",
        "quantity": "numeric",
        "base_unit_of_measure": "text",
        "created_at": "timestamptz",
        "updated_at": "timestamptz"
    },
    "incoming": {
        "user_id": "uuid",
        "material": "text",
        "material_description": "text",
        "batch": "text",
        "plant": "text",
        "storage_location": "text",
        "material_document": "text",
        "quantity": "numeric",
        "posting_date": "date",
        "valuation_type": "text",
        "inv_expiry_date": "date",
        "inv_plants": "text",
        "inv_slocs": "text",
        "inv_total_qty": "numeric",
        "inv_material_group": "text",
        "sl_at_receipt_days": "numeric",
        "receipt_flag": "text",
        "remaining_sl_days": "numeric",
        "ratio": "numeric",
        "flag": "text",
        "is_expired": "boolean",
        "data_error": "boolean",
        "created_at": "timestamptz",
        "updated_at": "timestamptz"
    },
    "audit_log": {
        "user_id": "uuid",
        "action": "text",
        "table_name": "text",
        "record_count": "integer",
        "details": "jsonb",
        "created_at": "timestamptz"
    }
}

# ── HELPER FUNCTIONS ──────────────────────────────────────────────────────

def get_supabase() -> Optional[Client]:
    """Get Supabase client from session state."""
    from supabase_auth import init_supabase
    return init_supabase()

def get_user_id() -> Optional[str]:
    """Get current user ID."""
    from supabase_auth import get_current_user
    user = get_current_user()
    return user.get("id") if user else None

def sanitize_data(data: List[Dict], table: str) -> List[Dict]:
    """Sanitize data for database insertion."""
    if not data:
        return []
    
    # Get allowed columns for the table
    allowed_cols = set(TABLE_SCHEMAS.get(table, {}).keys())
    
    # Filter and clean data
    sanitized = []
    for row in data:
        clean_row = {}
        for key, value in row.items():
            # Convert key to snake_case for DB
            db_key = key.lower().replace(" ", "_")
            if db_key in allowed_cols:
                # Handle special types
                if isinstance(value, (pd.Timestamp, datetime)):
                    clean_row[db_key] = value.isoformat() if hasattr(value, 'isoformat') else str(value)
                elif pd.isna(value) or value is None:
                    clean_row[db_key] = None
                elif isinstance(value, (list, dict)):
                    clean_row[db_key] = json.dumps(value)
                else:
                    clean_row[db_key] = value
        sanitized.append(clean_row)
    return sanitized

# ── INVENTORY OPERATIONS ──────────────────────────────────────────────────

def save_inventory(data: List[Dict]) -> Tuple[bool, str]:
    """Save inventory data to database."""
    supabase = get_supabase()
    user_id = get_user_id()
    if not supabase or not user_id:
        return False, "Not authenticated or database not connected"
    
    try:
        # Delete existing data for user
        supabase.table("inventory").delete().eq("user_id", user_id).execute()
        
        if not data:
            return True, "Data cleared"
        
        # Sanitize and prepare data
        clean_data = sanitize_data(data, "inventory")
        for row in clean_data:
            row["user_id"] = user_id
            row["created_at"] = datetime.now().isoformat()
        
        # Insert in chunks
        chunk_size = 500
        for i in range(0, len(clean_data), chunk_size):
            chunk = clean_data[i:i+chunk_size]
            supabase.table("inventory").insert(chunk).execute()
        
        # Log action
        _log_action("save_inventory", "inventory", len(data))
        return True, f"Saved {len(data)} records"
    except Exception as e:
        return False, str(e)

def load_inventory() -> List[Dict]:
    """Load inventory data from database."""
    supabase = get_supabase()
    user_id = get_user_id()
    if not supabase or not user_id:
        return []
    
    try:
        response = supabase.table("inventory").select("*").eq("user_id", user_id).execute()
        return response.data if response.data else []
    except Exception as e:
        st.error(f"Failed to load inventory: {e}")
        return []

def get_inventory_stats() -> Dict:
    """Get inventory statistics."""
    data = load_inventory()
    if not data:
        return {
            "total_records": 0,
            "unique_materials": 0,
            "unique_plants": 0,
            "total_value": 0,
            "last_updated": None
        }
    
    df = pd.DataFrame(data)
    return {
        "total_records": len(data),
        "unique_materials": len(df["material"].unique()) if "material" in df else 0,
        "unique_plants": len(df["plant_name"].unique()) if "plant_name" in df else 0,
        "total_value": df["total_value"].sum() if "total_value" in df else 0,
        "last_updated": df["created_at"].max() if "created_at" in df else None
    }

# ── MAPPING OPERATIONS ────────────────────────────────────────────────────

def save_mapping(data: List[Dict]) -> Tuple[bool, str]:
    """Save mapping data to database."""
    supabase = get_supabase()
    user_id = get_user_id()
    if not supabase or not user_id:
        return False, "Not authenticated or database not connected"
    
    try:
        supabase.table("mapping").delete().eq("user_id", user_id).execute()
        
        if not data:
            return True, "Mapping cleared"
        
        clean_data = sanitize_data(data, "mapping")
        for row in clean_data:
            row["user_id"] = user_id
            row["created_at"] = datetime.now().isoformat()
        
        if clean_data:
            supabase.table("mapping").insert(clean_data).execute()
        
        _log_action("save_mapping", "mapping", len(data))
        return True, f"Saved {len(data)} mapping rules"
    except Exception as e:
        return False, str(e)

def load_mapping() -> List[Dict]:
    """Load mapping data from database."""
    supabase = get_supabase()
    user_id = get_user_id()
    if not supabase or not user_id:
        return []
    
    try:
        response = supabase.table("mapping").select("*").eq("user_id", user_id).execute()
        return response.data if response.data else []
    except Exception as e:
        st.error(f"Failed to load mapping: {e}")
        return []

# ── TRANSIT OPERATIONS ────────────────────────────────────────────────────

def save_transit(data: List[Dict]) -> Tuple[bool, str]:
    """Save transit data to database."""
    supabase = get_supabase()
    user_id = get_user_id()
    if not supabase or not user_id:
        return False, "Not authenticated or database not connected"
    
    try:
        supabase.table("transit").delete().eq("user_id", user_id).execute()
        
        if not data:
            return True, "Transit data cleared"
        
        clean_data = sanitize_data(data, "transit")
        for row in clean_data:
            row["user_id"] = user_id
            row["created_at"] = datetime.now().isoformat()
        
        if clean_data:
            supabase.table("transit").insert(clean_data).execute()
        
        _log_action("save_transit", "transit", len(data))
        return True, f"Saved {len(data)} transit records"
    except Exception as e:
        return False, str(e)

def load_transit() -> List[Dict]:
    """Load transit data from database."""
    supabase = get_supabase()
    user_id = get_user_id()
    if not supabase or not user_id:
        return []
    
    try:
        response = supabase.table("transit").select("*").eq("user_id", user_id).execute()
        return response.data if response.data else []
    except Exception as e:
        st.error(f"Failed to load transit: {e}")
        return []

# ── INCOMING GOODS OPERATIONS ─────────────────────────────────────────────

def save_incoming(data: List[Dict]) -> Tuple[bool, str]:
    """Save incoming goods data to database."""
    supabase = get_supabase()
    user_id = get_user_id()
    if not supabase or not user_id:
        return False, "Not authenticated or database not connected"
    
    try:
        supabase.table("incoming").delete().eq("user_id", user_id).execute()
        
        if not data:
            return True, "Incoming data cleared"
        
        clean_data = sanitize_data(data, "incoming")
        for row in clean_data:
            row["user_id"] = user_id
            row["created_at"] = datetime.now().isoformat()
        
        if clean_data:
            supabase.table("incoming").insert(clean_data).execute()
        
        _log_action("save_incoming", "incoming", len(data))
        return True, f"Saved {len(data)} incoming records"
    except Exception as e:
        return False, str(e)

def load_incoming() -> List[Dict]:
    """Load incoming goods data from database."""
    supabase = get_supabase()
    user_id = get_user_id()
    if not supabase or not user_id:
        return []
    
    try:
        response = supabase.table("incoming").select("*").eq("user_id", user_id).execute()
        return response.data if response.data else []
    except Exception as e:
        st.error(f"Failed to load incoming: {e}")
        return []

# ── AUDIT LOG ──────────────────────────────────────────────────────────────

def _log_action(action: str, table_name: str, record_count: int = 0, details: Dict = None):
    """Log user action."""
    supabase = get_supabase()
    user_id = get_user_id()
    if not supabase or not user_id:
        return
    
    try:
        supabase.table("audit_log").insert({
            "user_id": user_id,
            "action": action,
            "table_name": table_name,
            "record_count": record_count,
            "details": json.dumps(details) if details else None,
            "created_at": datetime.now().isoformat()
        }).execute()
    except:
        pass

def get_audit_log(limit: int = 100) -> List[Dict]:
    """Get audit log for current user."""
    supabase = get_supabase()
    user_id = get_user_id()
    if not supabase or not user_id:
        return []
    
    try:
        response = supabase.table("audit_log").select("*").eq("user_id", user_id).order("created_at", desc=True).limit(limit).execute()
        return response.data if response.data else []
    except Exception as e:
        st.error(f"Failed to load audit log: {e}")
        return []

# ── DATA MANAGEMENT UI ──────────────────────────────────────────────────

def render_data_manager():
    """Render data management UI."""
    st.sidebar.markdown("---")
    st.sidebar.subheader("💾 Data Management")
    
    with st.sidebar.expander("Data Operations", expanded=False):
        # Inventory
        col1, col2 = st.columns(2)
        with col1:
            if st.button("💾 Save Inventory", use_container_width=True):
                if "inventory_data" in st.session_state and st.session_state.inventory_data:
                    success, msg = save_inventory(st.session_state.inventory_data)
                    if success:
                        st.success(msg)
                    else:
                        st.error(msg)
                else:
                    st.warning("No inventory data loaded")
        with col2:
            if st.button("📂 Load Inventory", use_container_width=True):
                data = load_inventory()
                if data:
                    st.session_state.inventory_data = data
                    st.success(f"Loaded {len(data)} records")
                else:
                    st.info("No saved inventory data found")
        
        # Mapping
        col1, col2 = st.columns(2)
        with col1:
            if st.button("💾 Save Mapping", use_container_width=True):
                if "mapping_data" in st.session_state and st.session_state.mapping_data:
                    success, msg = save_mapping(st.session_state.mapping_data)
                    if success:
                        st.success(msg)
                    else:
                        st.error(msg)
                else:
                    st.warning("No mapping data loaded")
        with col2:
            if st.button("📂 Load Mapping", use_container_width=True):
                data = load_mapping()
                if data:
                    st.session_state.mapping_data = data
                    st.success(f"Loaded {len(data)} mapping rules")
                else:
                    st.info("No saved mapping found")
        
        # Transit
        col1, col2 = st.columns(2)
        with col1:
            if st.button("💾 Save Transit", use_container_width=True):
                if "transit_data" in st.session_state and st.session_state.transit_data:
                    success, msg = save_transit(st.session_state.transit_data)
                    if success:
                        st.success(msg)
                    else:
                        st.error(msg)
                else:
                    st.warning("No transit data loaded")
        with col2:
            if st.button("📂 Load Transit", use_container_width=True):
                data = load_transit()
                if data:
                    st.session_state.transit_data = data
                    st.success(f"Loaded {len(data)} records")
                else:
                    st.info("No saved transit data found")
        
        # Incoming
        col1, col2 = st.columns(2)
        with col1:
            if st.button("💾 Save Incoming", use_container_width=True):
                if "incoming_data" in st.session_state and st.session_state.incoming_data:
                    success, msg = save_incoming(st.session_state.incoming_data)
                    if success:
                        st.success(msg)
                    else:
                        st.error(msg)
                else:
                    st.warning("No incoming data loaded")
        with col2:
            if st.button("📂 Load Incoming", use_container_width=True):
                data = load_incoming()
                if data:
                    st.session_state.incoming_data = data
                    st.success(f"Loaded {len(data)} records")
                else:
                    st.info("No saved incoming data found")
    
    # Data stats
    with st.sidebar.expander("📊 Data Stats", expanded=False):
        stats = get_inventory_stats()
        st.metric("Total Records", f"{stats['total_records']:,}")
        st.metric("Unique Materials", f"{stats['unique_materials']:,}")
        st.metric("Unique Plants", f"{stats['unique_plants']:,}")
        st.metric("Total Value", f"ETB {stats['total_value']:,.0f}")
        if stats['last_updated']:
            st.caption(f"Last updated: {stats['last_updated'][:19]}")

    # Audit log
    with st.sidebar.expander("📋 Audit Log", expanded=False):
        logs = get_audit_log(limit=50)
        if logs:
            for log in logs[:10]:
                st.caption(f"🕐 {log['created_at'][:16]} - {log['action']} ({log['record_count']} records)")
        else:
            st.caption("No audit logs found")