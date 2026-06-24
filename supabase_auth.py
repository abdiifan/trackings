# =============================================================================
# supabase_auth.py - Supabase Authentication Module
# =============================================================================

import streamlit as st
from supabase import create_client, Client
from typing import Optional, Dict, Tuple
import hashlib
import hmac
import time
import json

def init_supabase() -> Optional[Client]:
    """Initialize Supabase client."""
    try:
        url = st.secrets.get("supabase", {}).get("url", "")
        key = st.secrets.get("supabase", {}).get("key", "")
        if not url or not key:
            st.error("Supabase credentials not configured. Please check secrets.toml")
            return None
        return create_client(url, key)
    except Exception as e:
        st.error(f"Failed to connect to Supabase: {str(e)}")
        return None

def get_current_user() -> Optional[Dict]:
    """Get current user from session state."""
    return st.session_state.get("user", None)

def is_authenticated() -> bool:
    """Check if user is authenticated."""
    user = get_current_user()
    if not user:
        return False
    # Check if session is still valid
    try:
        supabase = init_supabase()
        if supabase:
            response = supabase.auth.get_user(user.get("access_token", ""))
            return response.user is not None
    except:
        # If token expired, try to refresh
        try:
            supabase = init_supabase()
            if supabase:
                response = supabase.auth.refresh_session()
                if response.user:
                    st.session_state.user["access_token"] = response.session.access_token
                    return True
        except:
            pass
        return False
    return False

def login_with_email(email: str, password: str) -> Tuple[bool, str]:
    """Login with email and password."""
    supabase = init_supabase()
    if not supabase:
        return False, "Supabase not configured"
    
    try:
        response = supabase.auth.sign_in_with_password({
            "email": email,
            "password": password
        })
        if response.user:
            st.session_state.user = {
                "id": response.user.id,
                "email": response.user.email,
                "access_token": response.session.access_token,
                "refresh_token": response.session.refresh_token,
                "full_name": response.user.user_metadata.get("full_name", ""),
                "role": response.user.user_metadata.get("role", "user"),
                "logged_in_at": time.time()
            }
            return True, "Login successful"
        return False, "Invalid credentials"
    except Exception as e:
        error_msg = str(e)
        if "Invalid login credentials" in error_msg:
            return False, "Invalid email or password"
        return False, f"Login error: {error_msg}"

def signup_with_email(email: str, password: str, full_name: str = "") -> Tuple[bool, str]:
    """Sign up with email and password."""
    supabase = init_supabase()
    if not supabase:
        return False, "Supabase not configured"
    
    try:
        response = supabase.auth.sign_up({
            "email": email,
            "password": password,
            "options": {
                "data": {
                    "full_name": full_name or email.split("@")[0],
                    "role": "user"
                }
            }
        })
        if response.user:
            st.session_state.user = {
                "id": response.user.id,
                "email": response.user.email,
                "access_token": response.session.access_token if response.session else None,
                "refresh_token": response.session.refresh_token if response.session else None,
                "full_name": response.user.user_metadata.get("full_name", ""),
                "role": response.user.user_metadata.get("role", "user"),
                "logged_in_at": time.time()
            }
            return True, "Signup successful! Please verify your email."
        return False, "Signup failed"
    except Exception as e:
        error_msg = str(e)
        if "User already registered" in error_msg:
            return False, "Email already registered. Please login."
        return False, f"Signup error: {error_msg}"

def logout_user():
    """Logout current user."""
    supabase = init_supabase()
    if supabase:
        try:
            supabase.auth.sign_out()
        except:
            pass
    # Clear all session data
    keys_to_clear = ["user", "inventory_data", "mapping_data", "transit_data", 
                     "incoming_data", "current_page", "filters"]
    for key in keys_to_clear:
        if key in st.session_state:
            del st.session_state[key]

def reset_password(email: str) -> Tuple[bool, str]:
    """Send password reset email."""
    supabase = init_supabase()
    if not supabase:
        return False, "Supabase not configured"
    
    try:
        supabase.auth.reset_password_for_email(email)
        return True, "Password reset email sent! Check your inbox."
    except Exception as e:
        return False, f"Error: {str(e)}"

def update_password(new_password: str) -> Tuple[bool, str]:
    """Update user password."""
    supabase = init_supabase()
    if not supabase:
        return False, "Supabase not configured"
    
    try:
        supabase.auth.update_user({"password": new_password})
        return True, "Password updated successfully!"
    except Exception as e:
        return False, f"Error: {str(e)}"

def get_user_profile() -> Optional[Dict]:
    """Get user profile from Supabase."""
    supabase = init_supabase()
    if not supabase or not is_authenticated():
        return None
    
    try:
        user = get_current_user()
        response = supabase.from_("profiles").select("*").eq("id", user["id"]).execute()
        if response.data and len(response.data) > 0:
            return response.data[0]
        return None
    except Exception as e:
        st.error(f"Failed to get user profile: {e}")
        return None

def update_user_profile(updates: Dict) -> Tuple[bool, str]:
    """Update user profile."""
    supabase = init_supabase()
    if not supabase or not is_authenticated():
        return False, "Not authenticated"
    
    try:
        user = get_current_user()
        response = supabase.from_("profiles").update(updates).eq("id", user["id"]).execute()
        return True, "Profile updated successfully!"
    except Exception as e:
        return False, f"Error: {str(e)}"

# ── UI COMPONENTS ──────────────────────────────────────────────────────────

def login_page():
    """Display login/signup page."""
    st.markdown("""
        <div style="text-align: center; padding: 2rem 0;">
            <h1 style="color: #3a8fd4;">📊 PharmaTrack</h1>
            <p style="color: #666; font-size: 1.1rem;">Pharmaceutical Inventory Management</p>
        </div>
    """, unsafe_allow_html=True)
    
    col1, col2, col3 = st.columns([1, 2, 1])
    with col2:
        tab1, tab2 = st.tabs(["🔐 Login", "📝 Sign Up"])
        
        with tab1:
            with st.form("login_form"):
                email = st.text_input("Email", placeholder="your@email.com")
                password = st.text_input("Password", type="password")
                submitted = st.form_submit_button("Login", use_container_width=True)
                
                if submitted:
                    if email and password:
                        with st.spinner("Logging in..."):
                            success, message = login_with_email(email, password)
                            if success:
                                st.success(message)
                                st.rerun()
                            else:
                                st.error(message)
                    else:
                        st.warning("Please fill in all fields")
            
            # Password reset link
            with st.expander("Forgot Password?"):
                reset_email = st.text_input("Enter your email", placeholder="your@email.com")
                if st.button("Send Reset Link"):
                    if reset_email:
                        with st.spinner("Sending reset link..."):
                            success, message = reset_password(reset_email)
                            if success:
                                st.success(message)
                            else:
                                st.error(message)
                    else:
                        st.warning("Please enter your email")
        
        with tab2:
            with st.form("signup_form"):
                full_name = st.text_input("Full Name", placeholder="John Doe")
                email = st.text_input("Email", placeholder="your@email.com")
                password = st.text_input("Password", type="password", 
                                         help="Minimum 6 characters")
                confirm_password = st.text_input("Confirm Password", type="password")
                submitted = st.form_submit_button("Create Account", use_container_width=True)
                
                if submitted:
                    if not email or not password:
                        st.warning("Please fill in all required fields")
                    elif password != confirm_password:
                        st.error("Passwords do not match")
                    elif len(password) < 6:
                        st.error("Password must be at least 6 characters")
                    else:
                        with st.spinner("Creating account..."):
                            success, message = signup_with_email(email, password, full_name)
                            if success:
                                st.success(message)
                                if "verify your email" in message.lower():
                                    st.info("Please check your email to verify your account before logging in.")
                                else:
                                    st.rerun()
                            else:
                                st.error(message)

def auth_required(func):
    """Decorator to require authentication for a page."""
    def wrapper(*args, **kwargs):
        if not is_authenticated():
            st.warning("Please login to access this page.")
            login_page()
            return
        return func(*args, **kwargs)
    return wrapper

def render_user_menu():
    """Render user menu in sidebar."""
    user = get_current_user()
    if user:
        with st.sidebar:
            st.divider()
            col1, col2 = st.columns([3, 1])
            with col1:
                st.write(f"👤 {user.get('full_name', user.get('email', 'User'))}")
                st.caption(f"📧 {user.get('email', '')}")
            with col2:
                if st.button("🚪 Logout", use_container_width=True):
                    logout_user()
                    st.rerun()