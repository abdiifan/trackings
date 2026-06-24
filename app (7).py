# =============================================================================
# app.py - Main Streamlit Application
# =============================================================================

import streamlit as st
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from datetime import datetime, timedelta
import time

# Import modules
from supabase_auth import (
    is_authenticated, login_page, render_user_menu, 
    get_current_user, auth_required
)
from supabase_db import (
    save_inventory, load_inventory, save_mapping, load_mapping,
    save_transit, load_transit, save_incoming, load_incoming,
    render_data_manager
)
from inventory_manager import (
    process_inventory_file, process_transit_file, process_incoming_file,
    MappingTable, PhantomTransitDetector,
    group_by, sort_by, aggregate_by_material,
    fmt_etb, fmt_qty, fmt_pct, fmt_local_date,
    get_valuation_type, is_non_medical_code, is_non_medical_group,
    is_excluded_storage_location, is_project_stock_description,
    COLORWAY
)

# ── PAGE CONFIG ────────────────────────────────────────────────────────────

st.set_page_config(
    page_title="PharmaTrack - Inventory Management",
    page_icon="📊",
    layout="wide",
    initial_sidebar_state="expanded"
)

# ── SESSION STATE INIT ────────────────────────────────────────────────────

if "user" not in st.session_state:
    st.session_state.user = None
if "inventory_data" not in st.session_state:
    st.session_state.inventory_data = None
if "mapping_data" not in st.session_state:
    st.session_state.mapping_data = None
if "transit_data" not in st.session_state:
    st.session_state.transit_data = None
if "incoming_data" not in st.session_state:
    st.session_state.incoming_data = None
if "current_page" not in st.session_state:
    st.session_state.current_page = "Dashboard"
if "filters" not in st.session_state:
    st.session_state.filters = {
        "plants": [],
        "mgs": [],
        "val_types": [],
        "materials": []
    }
if "mapping" not in st.session_state:
    st.session_state.mapping = MappingTable()
if "phantom" not in st.session_state:
    st.session_state.phantom = PhantomTransitDetector()

# ── CSS STYLES ────────────────────────────────────────────────────────────

st.markdown("""
<style>
    /* Main header */
    .main-header {
        background: linear-gradient(135deg, #0e1420 0%, #1a2438 100%);
        padding: 1rem 2rem;
        border-radius: 10px;
        margin-bottom: 1.5rem;
        border: 1px solid #1f2e44;
    }
    .main-header h1 {
        color: #3d94e0;
        font-size: 1.8rem;
        margin: 0;
        font-weight: 700;
    }
    .main-header p {
        color: #7a9ab8;
        margin: 0;
        font-size: 0.9rem;
    }
    
    /* KPI Cards */
    .kpi-card {
        background: #0e1420;
        border: 1px solid #1f2e44;
        border-radius: 10px;
        padding: 1rem 1.2rem;
        text-align: center;
        transition: all 0.2s ease;
    }
    .kpi-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 20px rgba(0,0,0,0.3);
    }
    .kpi-card .label {
        color: #7a9ab8;
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-weight: 600;
    }
    .kpi-card .value {
        color: #dce8f5;
        font-size: 1.4rem;
        font-weight: 700;
        margin: 0.3rem 0;
    }
    .kpi-card .sub {
        color: #4a6275;
        font-size: 0.65rem;
    }
    .kpi-card.blue .value { color: #3d94e0; }
    .kpi-card.green .value { color: #30a85f; }
    .kpi-card.amber .value { color: #d4872a; }
    .kpi-card.red .value { color: #e04545; }
    .kpi-card.purple .value { color: #9471d6; }
    
    /* Badges */
    .badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 0.65rem;
        font-weight: 700;
    }
    .badge-red { background: rgba(224,69,69,0.16); color: #e04545; }
    .badge-amber { background: rgba(212,135,42,0.16); color: #d4872a; }
    .badge-green { background: rgba(48,168,95,0.16); color: #30a85f; }
    
    /* Data frame styling */
    .dataframe {
        border: 1px solid #1f2e44 !important;
        border-radius: 8px !important;
        overflow: hidden !important;
    }
    .dataframe thead th {
        background: #0e1420 !important;
        color: #7a9ab8 !important;
        font-size: 0.65rem !important;
        text-transform: uppercase !important;
        letter-spacing: 0.08em !important;
        padding: 0.6rem 0.8rem !important;
    }
    .dataframe tbody td {
        padding: 0.4rem 0.8rem !important;
        font-size: 0.8rem !important;
    }
    
    /* Sidebar */
    .sidebar-content {
        padding: 0 0.5rem;
    }
    .sidebar-divider {
        border: none;
        border-top: 1px solid #1f2e44;
        margin: 0.8rem 0;
    }
    
    /* Upload area */
    .upload-area {
        border: 1.5px dashed #1f2e44;
        border-radius: 10px;
        padding: 1rem;
        text-align: center;
        background: #0e1420;
        transition: all 0.2s ease;
    }
    .upload-area:hover {
        border-color: #3d94e0;
        background: #141c2b;
    }
    
    /* Hide Streamlit branding */
    #MainMenu {visibility: hidden;}
    footer {visibility: hidden;}
    .stDeployButton {display: none;}
</style>
""", unsafe_allow_html=True)

# ── AUTHENTICATION ─────────────────────────────────────────────────────────

if not is_authenticated():
    login_page()
    st.stop()

# ── SIDEBAR ───────────────────────────────────────────────────────────────

with st.sidebar:
    st.markdown("""
        <div style="text-align: center; padding: 0.5rem 0;">
            <h2 style="color: #3d94e0; margin: 0;">📊 PharmaTrack</h2>
            <p style="color: #7a9ab8; font-size: 0.8rem; margin: 0;">Inventory Management</p>
        </div>
    """, unsafe_allow_html=True)
    
    st.markdown("---")
    
    # Navigation
    pages = [
        "📊 Dashboard",
        "🚚 Stock in Transit",
        "⏰ Expiry Watchlist",
        "🔬 Quality Inspection",
        "🏢 Branch Comparison",
        "📦 Zero Unrestricted",
        "🧪 Shelf Life Lookup",
        "🎯 Stock Concentration",
        "⚙️ Settings"
    ]
    
    selection = st.radio("Navigation", pages, index=0)
    st.session_state.current_page = selection
    
    st.markdown("---")
    
    # File Uploads
    st.subheader("📤 Data Upload")
    
    # Inventory upload
    inventory_file = st.file_uploader(
        "📂 Inventory Excel",
        type=["xlsx", "xls"],
        key="inventory_upload",
        help="Upload your pharmaceutical inventory Excel file"
    )
    if inventory_file:
        with st.spinner("Processing inventory file..."):
            df = pd.read_excel(inventory_file, engine="openpyxl")
            data, errors = process_inventory_file(df)
            if errors:
                st.error(f"Errors: {', '.join(errors)}")
            elif data:
                st.session_state.inventory_data = data
                st.success(f"✅ Loaded {len(data)} records")
                # Apply mapping if active
                if st.session_state.mapping.is_active():
                    st.session_state.mapping.apply_to_data(data)
                st.rerun()
    
    # Mapping upload
    mapping_file = st.file_uploader(
        "🗺️ Mapping Excel",
        type=["xlsx", "xls"],
        key="mapping_upload",
        help="Upload material standardization mapping"
    )
    if mapping_file:
        with st.spinner("Processing mapping file..."):
            df = pd.read_excel(mapping_file, engine="openpyxl")
            data = df.to_dict('records')
            result = st.session_state.mapping.load_from_data(data)
            if result.get("success"):
                st.session_state.mapping_data = data
                st.success(f"✅ Loaded {result['count']} mapping rules")
                # Re-apply mapping to existing data
                if st.session_state.inventory_data:
                    st.session_state.mapping.apply_to_data(st.session_state.inventory_data)
                st.rerun()
            else:
                st.error(f"❌ {result.get('message', 'Failed to load mapping')}")
    
    # Transit upload
    transit_file = st.file_uploader(
        "📦 Transit Excel",
        type=["xlsx", "xls"],
        key="transit_upload",
        help="Upload stock in transit detail file"
    )
    if transit_file:
        with st.spinner("Processing transit file..."):
            df = pd.read_excel(transit_file, engine="openpyxl")
            data, errors = process_transit_file(df)
            if errors:
                st.error(f"Errors: {', '.join(errors)}")
            elif data:
                st.session_state.transit_data = data
                allowed = set(str(r.get("Material", "")).strip() for r in st.session_state.inventory_data or [])
                st.session_state.phantom.load_transit_data(data, allowed)
                st.success(f"✅ Loaded {len(data)} transit records")
                st.rerun()
    
    # Incoming upload
    incoming_file = st.file_uploader(
        "📥 Received Goods Excel",
        type=["xlsx", "xls"],
        key="incoming_upload",
        help="Upload received goods file for shelf life analysis"
    )
    if incoming_file:
        with st.spinner("Processing incoming goods file..."):
            df = pd.read_excel(incoming_file, engine="openpyxl")
            data, errors = process_incoming_file(df)
            if errors:
                st.error(f"Errors: {', '.join(errors)}")
            elif data:
                st.session_state.incoming_data = data
                st.success(f"✅ Loaded {len(data)} incoming records")
                st.rerun()
    
    st.markdown("---")
    
    # Data management
    render_data_manager()
    
    # User menu
    render_user_menu()

# ── MAIN CONTENT ──────────────────────────────────────────────────────────

st.markdown("""
    <div class="main-header">
        <h1>{}</h1>
        <p>{}</p>
    </div>
""".format(
    st.session_state.current_page,
    "Pharmaceutical inventory analysis and management"
), unsafe_allow_html=True)

# ── PAGE RENDERERS ────────────────────────────────────────────────────────

def render_dashboard():
    """Render dashboard page."""
    data = st.session_state.inventory_data
    if not data:
        st.info("📂 Please upload an inventory Excel file using the sidebar to begin analysis.")
        return
    
    mapping = st.session_state.mapping
    phantom = st.session_state.phantom
    
    # Apply filters
    filters = st.session_state.filters
    plants = filters.get("plants", [])
    mgs = filters.get("mgs", [])
    val_types = filters.get("val_types", [])
    
    # Filter data
    filtered = []
    for r in data:
        if plants and r.get("Plant Name") not in plants:
            continue
        if mgs and r.get("Material Group Name") not in mgs:
            continue
        if val_types and get_valuation_type(r) not in val_types:
            continue
        filtered.append(r)
    
    if not filtered:
        st.warning("No data matches the current filters.")
        return
    
    # ── KPIs ──
    avail_val = sum(mapping.get_mapped_value(r, "Value of Unrestricted Stock") for r in filtered)
    avail_qty = sum(mapping.get_mapped_quantity(r, "Unrestricted Stock") for r in filtered)
    transit_val = sum(phantom.get_verified_transit_val(r) for r in filtered)
    transit_qty = sum(phantom.get_verified_transit_qty(r) for r in filtered)
    qc_val = sum(mapping.get_mapped_value(r, "Value of Stock in Quality Inspection") for r in filtered)
    qc_qty = sum(mapping.get_mapped_quantity(r, "Stock in Quality Inspection") for r in filtered)
    
    col1, col2, col3, col4, col5 = st.columns(5)
    
    with col1:
        st.markdown(f"""
            <div class="kpi-card blue">
                <div class="label">Total Inventory Value</div>
                <div class="value">{fmt_etb(avail_val + transit_val + qc_val)}</div>
                <div class="sub">{fmt_qty(avail_qty + transit_qty + qc_qty)} total units</div>
            </div>
        """, unsafe_allow_html=True)
    
    with col2:
        st.markdown(f"""
            <div class="kpi-card amber">
                <div class="label">Stock in Transit</div>
                <div class="value">{fmt_etb(transit_val)}</div>
                <div class="sub">{fmt_qty(transit_qty)} units</div>
            </div>
        """, unsafe_allow_html=True)
    
    with col3:
        st.markdown(f"""
            <div class="kpi-card red">
                <div class="label">In Quality Inspection</div>
                <div class="value">{fmt_etb(qc_val)}</div>
                <div class="sub">{fmt_qty(qc_qty)} units</div>
            </div>
        """, unsafe_allow_html=True)
    
    with col4:
        st.markdown(f"""
            <div class="kpi-card green">
                <div class="label">Available Stock</div>
                <div class="value">{fmt_etb(avail_val)}</div>
                <div class="sub">{fmt_qty(avail_qty)} units</div>
            </div>
        """, unsafe_allow_html=True)
    
    with col5:
        unique_mats = len(set(r.get("_mapped_material", r.get("Material")) for r in filtered))
        unique_plants = len(set(r.get("Plant Name") for r in filtered))
        st.markdown(f"""
            <div class="kpi-card purple">
                <div class="label">Unique Materials</div>
                <div class="value">{unique_mats:,}</div>
                <div class="sub">{unique_plants} plants</div>
            </div>
        """, unsafe_allow_html=True)
    
    # Phantom alert
    phantom_summary = phantom.get_phantom_summary(filtered)
    if phantom_summary["count"] > 0:
        st.warning(f"⚠️ {phantom_summary['count']} unverified transit items ({fmt_qty(phantom_summary['qty'])} units, {fmt_etb(phantom_summary['val'])}) excluded from totals.")
    
    # ── Charts ──
    col1, col2 = st.columns(2)
    
    with col1:
        st.subheader("📊 Inventory Value by Plant")
        plant_agg = group_by(filtered, "Plant Name", [
            ("Unrestricted", "Value of Unrestricted Stock"),
            ("Transit", "Value of Stock in Transit"),
            ("QC", "Value of Stock in Quality Inspection"),
        ])
        if plant_agg:
            df = pd.DataFrame(plant_agg)
            fig = go.Figure()
            fig.add_trace(go.Bar(name="Unrestricted", x=df["Plant Name"], y=df["Unrestricted"], 
                                 marker_color="#3fb950"))
            fig.add_trace(go.Bar(name="In Transit", x=df["Plant Name"], y=df["Transit"], 
                                 marker_color="#d29922"))
            fig.add_trace(go.Bar(name="In QC", x=df["Plant Name"], y=df["QC"], 
                                 marker_color="#f85149"))
            fig.update_layout(barmode="stack", height=350, showlegend=True,
                              xaxis_title="Plant", yaxis_title="Value (ETB)",
                              template="plotly_dark")
            st.plotly_chart(fig, use_container_width=True)
    
    with col2:
        st.subheader("⚠️ Near-Expiry Risk by Plant")
        today = datetime.now()
        cutoff = today + timedelta(days=180)
        near_expiry = [r for r in filtered if 
                       isinstance(r.get("_expiry"), datetime) and
                       today <= r["_expiry"] <= cutoff and
                       (r.get("Unrestricted Stock", 0) or 0) > 0]
        if near_expiry:
            plant_risk = group_by(near_expiry, "Plant Name", [
                ("val", "Value of Unrestricted Stock"),
                ("qty", "Unrestricted Stock"),
            ])
            if plant_risk:
                df = pd.DataFrame(plant_risk)
                fig = go.Figure()
                fig.add_trace(go.Bar(name="Value at Risk", x=df["Plant Name"], y=df["val"],
                                     marker_color="#d29922"))
                fig.add_trace(go.Scatter(name="Qty at Risk", x=df["Plant Name"], y=df["qty"],
                                         mode="lines+markers", marker_color="#f85149", 
                                         yaxis="y2"))
                fig.update_layout(height=350, showlegend=True,
                                  xaxis_title="Plant",
                                  yaxis_title="Value (ETB)",
                                  yaxis2=dict(overlaying="y", side="right", 
                                              title="Quantity"),
                                  template="plotly_dark")
                st.plotly_chart(fig, use_container_width=True)
        else:
            st.info("✅ No near-expiry stock within 6 months.")

def render_transit():
    """Render stock in transit page."""
    data = st.session_state.inventory_data
    if not data:
        st.info("📂 Please upload an inventory Excel file first.")
        return
    
    filtered = []
    filters = st.session_state.filters
    plants = filters.get("plants", [])
    
    for r in data:
        if r.get("Stock in Transit", 0) <= 0:
            continue
        if plants and r.get("Plant Name") not in plants:
            continue
        filtered.append(r)
    
    if not filtered:
        st.info("No stock in transit found.")
        return
    
    mapping = st.session_state.mapping
    phantom = st.session_state.phantom
    
    # ── KPIs ──
    total_val = sum(phantom.get_verified_transit_val(r) for r in filtered)
    total_qty = sum(phantom.get_verified_transit_qty(r) for r in filtered)
    unique_mats = len(set(r.get("_mapped_material", r.get("Material")) for r in filtered))
    
    col1, col2, col3 = st.columns(3)
    with col1:
        st.metric("Total Transit Value", fmt_etb(total_val))
    with col2:
        st.metric("Total Transit Quantity", fmt_qty(total_qty))
    with col3:
        st.metric("Unique Materials", f"{unique_mats:,}")
    
    # ── Chart ──
    plant_agg = group_by(filtered, "Plant Name", [
        ("val", "Value of Stock in Transit"),
        ("qty", "Stock in Transit"),
    ])
    if plant_agg:
        df = pd.DataFrame(plant_agg)
        fig = go.Figure()
        fig.add_trace(go.Bar(name="Value (ETB)", x=df["Plant Name"], y=df["val"],
                             marker_color="#d29922"))
        fig.add_trace(go.Scatter(name="Qty", x=df["Plant Name"], y=df["qty"],
                                 mode="lines+markers", marker_color="#3fb950",
                                 yaxis="y2"))
        fig.update_layout(height=300, showlegend=True,
                          xaxis_title="Plant",
                          yaxis_title="Value (ETB)",
                          yaxis2=dict(overlaying="y", side="right", title="Quantity"),
                          template="plotly_dark")
        st.plotly_chart(fig, use_container_width=True)
    
    # ── Table ──
    st.subheader("📋 Transit Details")
    rows = []
    for r in sorted(filtered, key=lambda x: x.get("Value of Stock in Transit", 0), reverse=True):
        info = phantom.get_transit_info(r.get("Material"), r.get("Plant"))
        val = r.get("Value of Stock in Transit", 0)
        if val > 100000:
            status = "🔴 Critical"
        elif val > 50000:
            status = "🟠 High"
        elif val > 10000:
            status = "🟡 Medium"
        else:
            status = "🟢 Low"
        rows.append({
            "Material": r.get("_mapped_material", r.get("Material")),
            "Description": r.get("_mapped_desc", r.get("Material Description")),
            "Plant": r.get("Plant Name"),
            "Purchasing Document": info["pur_doc"],
            "Supplying Plant": info["sup_plant"],
            "Transit Qty": fmt_qty(r.get("Stock in Transit")),
            "Transit Value": fmt_etb(r.get("Value of Stock in Transit")),
            "Status": status,
        })
    
    df = pd.DataFrame(rows)
    st.dataframe(df, use_container_width=True, height=400)

def render_expiry():
    """Render expiry watchlist page."""
    data = st.session_state.inventory_data
    if not data:
        st.info("📂 Please upload an inventory Excel file first.")
        return
    
    today = datetime.now()
    cutoff = today + timedelta(days=180)
    
    expiring = []
    expired = []
    for r in data:
        expiry = r.get("_expiry")
        if not isinstance(expiry, datetime):
            continue
        qty = r.get("Unrestricted Stock", 0)
        if qty <= 0:
            continue
        if expiry < today:
            expired.append(r)
        elif expiry <= cutoff:
            expiring.append(r)
    
    if not expiring and not expired:
        st.info("✅ No expired or near-expiry items found.")
        return
    
    # ── KPIs ──
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.metric("Expiring in 6 Months", f"{len(expiring):,}")
    with col2:
        st.metric("Already Expired", f"{len(expired):,}")
    with col3:
        val = sum(r.get("Value of Unrestricted Stock", 0) for r in expiring)
        st.metric("At-Risk Value", fmt_etb(val))
    with col4:
        qty = sum(r.get("Unrestricted Stock", 0) for r in expiring)
        st.metric("At-Risk Quantity", fmt_qty(qty))
    
    # ── Timeline ──
    if expiring:
        month_map = {}
        for r in expiring:
            key = r["_expiry"].strftime("%Y-%m")
            month_map[key] = month_map.get(key, 0) + 1
        
        df = pd.DataFrame({"Month": list(month_map.keys()), "Count": list(month_map.values())})
        fig = px.bar(df, x="Month", y="Count", title="Expiry Timeline", color_discrete_sequence=["#d29922"])
        fig.update_layout(template="plotly_dark", height=300)
        st.plotly_chart(fig, use_container_width=True)
    
    # ── Expired Items ──
    if expired:
        st.subheader("🔴 Already Expired Items")
        rows = []
        for r in sorted(expired, key=lambda x: x["_expiry"]):
            rows.append({
                "Material": r.get("_mapped_material", r.get("Material")),
                "Description": r.get("_mapped_desc", r.get("Material Description")),
                "Plant": r.get("Plant Name"),
                "Expiry Date": fmt_local_date(r.get("_expiry")),
                "Qty": fmt_qty(r.get("Unrestricted Stock")),
                "Value": fmt_etb(r.get("Value of Unrestricted Stock")),
            })
        df = pd.DataFrame(rows)
        st.dataframe(df, use_container_width=True, height=300)

def render_qc():
    """Render quality inspection page."""
    data = st.session_state.inventory_data
    if not data:
        st.info("📂 Please upload an inventory Excel file first.")
        return
    
    qc_items = [r for r in data if (r.get("Stock in Quality Inspection", 0) or 0) > 0]
    if not qc_items:
        st.info("✅ No items in quality inspection.")
        return
    
    # Aggregate by material
    aggregated = aggregate_by_material(qc_items)
    
    # ── KPIs ──
    total_val = sum(r.get("Value of Stock in Quality Inspection", 0) for r in qc_items)
    total_qty = sum(r.get("Stock in Quality Inspection", 0) for r in qc_items)
    
    col1, col2, col3 = st.columns(3)
    with col1:
        st.metric("Total QC Value", fmt_etb(total_val))
    with col2:
        st.metric("Total QC Quantity", fmt_qty(total_qty))
    with col3:
        st.metric("Unique Materials", f"{len(aggregated):,}")
    
    # ── Table ──
    st.subheader("🔬 Items in Quality Inspection")
    rows = []
    for r in sorted(aggregated, key=lambda x: x.get("Value of Stock in Quality Inspection", 0), reverse=True):
        rows.append({
            "Material": r.get("_mapped_material", r.get("Material")),
            "Description": r.get("_mapped_desc", r.get("Material Description")),
            "Plant(s)": r.get("_plant_list", "—"),
            "QC Qty": fmt_qty(r.get("Stock in Quality Inspection")),
            "QC Value": fmt_etb(r.get("Value of Stock in Quality Inspection")),
            "Expiry": fmt_local_date(r.get("_expiry")),
        })
    df = pd.DataFrame(rows)
    st.dataframe(df, use_container_width=True, height=400)

def render_branch():
    """Render branch comparison page."""
    data = st.session_state.inventory_data
    if not data:
        st.info("📂 Please upload an inventory Excel file first.")
        return
    
    # ── Branch totals ──
    branch_totals = {}
    for r in data:
        plant = r.get("Plant Name")
        if not plant:
            continue
        if plant not in branch_totals:
            branch_totals[plant] = 0
        branch_totals[plant] += r.get("Total Value", 0)
    
    if not branch_totals:
        st.warning("No branch data found.")
        return
    
    # ── KPIs ──
    total_val = sum(branch_totals.values())
    unique_branches = len(branch_totals)
    top_branch = max(branch_totals.items(), key=lambda x: x[1])
    
    col1, col2, col3 = st.columns(3)
    with col1:
        st.metric("Total Branches", f"{unique_branches:,}")
    with col2:
        st.metric("Total Inventory", fmt_etb(total_val))
    with col3:
        st.metric("Top Branch", f"{top_branch[0]}: {fmt_etb(top_branch[1])}")
    
    # ── Chart ──
    df = pd.DataFrame([
        {"Branch": k, "Value": v, "Pct": (v / total_val * 100) if total_val > 0 else 0}
        for k, v in sorted(branch_totals.items(), key=lambda x: x[1], reverse=True)
    ])
    fig = px.bar(df, x="Branch", y="Value", title="Inventory Value by Branch", 
                 color="Value", color_continuous_scale="Blues",
                 text="Pct")
    fig.update_traces(texttemplate='%{text:.1f}%', textposition='outside')
    fig.update_layout(template="plotly_dark", height=400, showlegend=False)
    st.plotly_chart(fig, use_container_width=True)
    
    # ── Table ──
    st.subheader("📋 Branch Details")
    st.dataframe(df, use_container_width=True)

def render_flow():
    """Render zero unrestricted stock page."""
    data = st.session_state.inventory_data
    if not data:
        st.info("📂 Please upload an inventory Excel file first.")
        return
    
    phantom = st.session_state.phantom
    mapping = st.session_state.mapping
    
    # ── KPIs ──
    avail_qty = sum(mapping.get_mapped_quantity(r, "Unrestricted Stock") for r in data)
    transit_qty = sum(phantom.get_verified_transit_qty(r) for r in data)
    qc_qty = sum(mapping.get_mapped_quantity(r, "Stock in Quality Inspection") for r in data)
    
    reorder_items = [r for r in data if (r.get("Unrestricted Stock", 0) or 0) == 0]
    
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.metric("Available Stock", fmt_qty(avail_qty))
    with col2:
        st.metric("In Transit", fmt_qty(transit_qty))
    with col3:
        st.metric("In QC", fmt_qty(qc_qty))
    with col4:
        st.metric("Reorder Alerts", f"{len(reorder_items):,}")
    
    # ── Reorder Alerts ──
    if reorder_items:
        st.subheader("🔴 Reorder Alerts - Zero Unrestricted Stock")
        rows = []
        for r in reorder_items:
            info = phantom.get_transit_info(r.get("Material"), r.get("Plant"))
            transit_q = phantom.get_verified_transit_qty(r)
            qc_q = mapping.get_mapped_quantity(r, "Stock in Quality Inspection")
            if transit_q > 0 and qc_q > 0:
                alert = "🔴 Transit+QC"
            elif transit_q > 0:
                alert = "🟠 Awaiting Transit"
            else:
                alert = "🟡 Awaiting QC"
            rows.append({
                "Material": r.get("_mapped_material", r.get("Material")),
                "Description": r.get("_mapped_desc", r.get("Material Description")),
                "Plant": r.get("Plant Name"),
                "In Transit": fmt_qty(transit_q),
                "In QC": fmt_qty(qc_q),
                "Alert": alert,
            })
        df = pd.DataFrame(rows)
        st.dataframe(df, use_container_width=True, height=300)
    else:
        st.success("✅ No reorder alerts - all materials have available stock.")

def render_incoming():
    """Render shelf life lookup page."""
    data = st.session_state.incoming_data
    if not data:
        st.info("📥 Please upload a Received Goods Excel file using the sidebar.")
        return
    
    inventory_data = st.session_state.inventory_data
    if not inventory_data:
        st.warning("⚠️ Inventory data not loaded. Upload inventory file for cross-matching.")
        return
    
    # Build inventory lookup
    inv_lookup = {}
    for r in inventory_data:
        mat = str(r.get("Material", "")).strip().upper()
        batch = str(r.get("Batch", "")).strip().upper()
        if mat and batch:
            key = f"{mat}||{batch}"
            if key not in inv_lookup:
                inv_lookup[key] = []
            inv_lookup[key].append(r)
    
    # Enrich incoming data
    enriched = []
    for r in data:
        mat = str(r.get("Material", "")).strip().upper()
        batch = str(r.get("Batch", "")).strip().upper()
        key = f"{mat}||{batch}"
        inv_rows = inv_lookup.get(key, [])
        
        if inv_rows:
            r["_in_inventory"] = True
            expiry_dates = [rr.get("_expiry") for rr in inv_rows if isinstance(rr.get("_expiry"), datetime)]
            if expiry_dates:
                r["_inv_expiry_date"] = min(expiry_dates)
            plants = set(rr.get("Plant Name") for rr in inv_rows)
            r["_inv_plants"] = ", ".join(sorted(plants))
            total_qty = sum(rr.get("Total Qty", 0) for rr in inv_rows)
            r["_inv_total_qty"] = total_qty
        else:
            r["_in_inventory"] = False
            r["_inv_expiry_date"] = None
            r["_inv_plants"] = "—"
            r["_inv_total_qty"] = 0
        
        # Compute SL metrics
        expiry = r.get("_inv_expiry_date")
        posting = r.get("_posting_date")
        if expiry and posting:
            remaining = (expiry - datetime.now()).days
            r["_remaining_sl"] = remaining
            at_receipt = (expiry - posting).days
            r["_sl_at_receipt_days"] = at_receipt
            if at_receipt < 548:  # <1.5 years
                r["_receipt_flag"] = "red"
            elif at_receipt <= 730:  # 1.5-2 years
                r["_receipt_flag"] = "yellow"
            else:
                r["_receipt_flag"] = "green"
        else:
            r["_remaining_sl"] = None
            r["_sl_at_receipt_days"] = None
            r["_receipt_flag"] = "grey"
        
        enriched.append(r)
    
    # Filter to only matched items
    matched = [r for r in enriched if r.get("_in_inventory")]
    if not matched:
        st.warning("No incoming goods matched with current inventory.")
        return
    
    # ── KPIs ──
    total = len(matched)
    green = len([r for r in matched if r.get("_receipt_flag") == "green"])
    yellow = len([r for r in matched if r.get("_receipt_flag") == "yellow"])
    red = len([r for r in matched if r.get("_receipt_flag") == "red"])
    
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.metric("Total Matched Batches", f"{total:,}")
    with col2:
        st.metric("🟢 Green (>2yr)", f"{green:,}")
    with col3:
        st.metric("🟡 Yellow (1.5-2yr)", f"{yellow:,}")
    with col4:
        st.metric("🔴 Red (<1.5yr)", f"{red:,}")
    
    # ── Table ──
    st.subheader("📋 Shelf Life Details")
    rows = []
    for r in sorted(matched, key=lambda x: x.get("_sl_at_receipt_days") or 0):
        rows.append({
            "Material": r.get("Material"),
            "Description": r.get("Material Description"),
            "Batch": r.get("Batch"),
            "Posting Date": fmt_local_date(r.get("_posting_date")),
            "Expiry Date": fmt_local_date(r.get("_inv_expiry_date")),
            "SL at Receipt": f"{r.get('_sl_at_receipt_days', '-')} days",
            "SL Remaining": f"{r.get('_remaining_sl', '-')} days",
            "Flag": "🟢" if r.get("_receipt_flag") == "green" else "🟡" if r.get("_receipt_flag") == "yellow" else "🔴" if r.get("_receipt_flag") == "red" else "⚪",
            "Plants": r.get("_inv_plants", "—"),
            "Total Qty": fmt_qty(r.get("_inv_total_qty")),
        })
    df = pd.DataFrame(rows)
    st.dataframe(df, use_container_width=True, height=400)

def render_concentration():
    """Render stock concentration page."""
    data = st.session_state.inventory_data
    if not data:
        st.info("📂 Please upload an inventory Excel file first.")
        return
    
    # Analyze per-material plant concentration
    mat_plants = {}
    for r in data:
        mat = r.get("_mapped_material", r.get("Material"))
        plant = r.get("Plant Name")
        qty = r.get("Unrestricted Stock", 0)
        if not mat or not plant or qty <= 0:
            continue
        if mat not in mat_plants:
            mat_plants[mat] = {"plants": {}, "total": 0, "desc": r.get("_mapped_desc", r.get("Material Description", ""))}
        mat_plants[mat]["plants"][plant] = mat_plants[mat]["plants"].get(plant, 0) + qty
        mat_plants[mat]["total"] += qty
    
    if not mat_plants:
        st.info("No materials with unrestricted stock found.")
        return
    
    # Classify concentration
    concentration = []
    for mat, info in mat_plants.items():
        plant_count = len(info["plants"])
        top_plant = max(info["plants"].items(), key=lambda x: x[1])
        top_pct = (top_plant[1] / info["total"] * 100) if info["total"] > 0 else 0
        concentration.append({
            "Material": mat,
            "Description": info["desc"],
            "Plants": plant_count,
            "Top Plant": top_plant[0],
            "Top Qty": top_plant[1],
            "Top %": top_pct,
            "Total Qty": info["total"],
        })
    
    # ── KPIs ──
    total_mats = len(concentration)
    sole = len([r for r in concentration if r["Top %"] >= 80])
    few = len([r for r in concentration if 2 <= r["Plants"] <= 4])
    
    col1, col2, col3 = st.columns(3)
    with col1:
        st.metric("Total Materials", f"{total_mats:,}")
    with col2:
        st.metric("Sole Branch (>80%)", f"{sole:,}")
    with col3:
        st.metric("Few Branches (2-4)", f"{few:,}")
    
    # ── Concentration Chart ──
    df = pd.DataFrame(concentration)
    df_sorted = df.sort_values("Top %", ascending=False)
    
    fig = px.bar(df_sorted.head(20), x="Material", y="Top %", 
                 title="Top 20 Materials - Concentration in Top Plant",
                 color="Top %", color_continuous_scale="RdYlGn_r",
                 hover_data=["Description", "Plants", "Top Plant"])
    fig.update_layout(template="plotly_dark", height=400)
    st.plotly_chart(fig, use_container_width=True)
    
    # ── Table ──
    st.subheader("📋 Material Concentration Details")
    rows = []
    for r in concentration:
        rows.append({
            "Material": r["Material"],
            "Description": r["Description"],
            "Plants": r["Plants"],
            "Top Plant": r["Top Plant"],
            "Top %": f"{r['Top %']:.1f}%",
            "Total Qty": fmt_qty(r["Total Qty"]),
            "Classification": "🔴 Sole" if r["Top %"] >= 80 else "🟡 Few" if r["Plants"] <= 4 else "🟢 Spread"
        })
    df = pd.DataFrame(rows)
    st.dataframe(df, use_container_width=True, height=400)

def render_settings():
    """Render settings page."""
    st.subheader("⚙️ Settings")
    
    # User profile
    st.markdown("### 👤 User Profile")
    user = get_current_user()
    if user:
        col1, col2 = st.columns(2)
        with col1:
            st.text_input("Email", value=user.get("email", ""), disabled=True)
            st.text_input("Full Name", value=user.get("full_name", ""), disabled=True)
        with col2:
            st.text_input("User ID", value=user.get("id", ""), disabled=True)
            st.text_input("Role", value=user.get("role", "user"), disabled=True)
    
    # Data management
    st.markdown("### 💾 Data Management")
    col1, col2, col3 = st.columns(3)
    with col1:
        if st.button("📤 Export All Data", use_container_width=True):
            data = st.session_state.inventory_data
            if data:
                df = pd.DataFrame(data)
                csv = df.to_csv(index=False)
                st.download_button("⬇ Download CSV", csv, "inventory_export.csv", "text/csv")
            else:
                st.warning("No data to export")
    
    with col2:
        if st.button("🗑️ Clear All Data", use_container_width=True):
            st.session_state.inventory_data = None
            st.session_state.mapping_data = None
            st.session_state.transit_data = None
            st.session_state.incoming_data = None
            st.success("All data cleared!")
            st.rerun()
    
    with col3:
        if st.button("🔄 Reset Filters", use_container_width=True):
            st.session_state.filters = {"plants": [], "mgs": [], "val_types": [], "materials": []}
            st.success("Filters reset!")
            st.rerun()
    
    # About
    st.markdown("### 📖 About")
    st.markdown("""
        **PharmaTrack v2.0** - Pharmaceutical Inventory Management System
        
        Built with:
        - Streamlit
        - Supabase (Authentication + Database)
        - Plotly
        - Pandas
        
        Features:
        - 📊 Dashboard with KPIs and charts
        - 🚚 Stock in transit tracking
        - ⏰ Expiry watchlist
        - 🔬 Quality inspection management
        - 🏢 Branch comparison
        - 📦 Zero unrestricted stock alerts
        - 🧪 Shelf life lookup
        - 🎯 Stock concentration analysis
    """)

# ── PAGE ROUTING ──────────────────────────────────────────────────────────

page_map = {
    "📊 Dashboard": render_dashboard,
    "🚚 Stock in Transit": render_transit,
    "⏰ Expiry Watchlist": render_expiry,
    "🔬 Quality Inspection": render_qc,
    "🏢 Branch Comparison": render_branch,
    "📦 Zero Unrestricted": render_flow,
    "🧪 Shelf Life Lookup": render_incoming,
    "🎯 Stock Concentration": render_concentration,
    "⚙️ Settings": render_settings,
}

# Render current page
current_page = st.session_state.current_page
if current_page in page_map:
    page_map[current_page]()
else:
    render_dashboard()