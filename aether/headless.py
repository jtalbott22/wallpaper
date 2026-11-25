"""Headless (surfaceless) EGL OpenGL 4.3 context, for previews and benchmarks."""
import ctypes as C
import ctypes.util

EGL_PLATFORM_SURFACELESS_MESA = 0x31DD
EGL_OPENGL_API = 0x30A2
EGL_CONTEXT_MAJOR_VERSION = 0x3098
EGL_CONTEXT_MINOR_VERSION = 0x30FB
EGL_CONTEXT_OPENGL_PROFILE_MASK = 0x30FD
EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT = 0x1
EGL_NONE = 0x3038


class HeadlessContext:
    def __init__(self):
        egl = C.CDLL(ctypes.util.find_library('EGL') or 'libEGL.so.1')
        self.egl = egl
        egl.eglGetProcAddress.restype = C.c_void_p
        egl.eglGetProcAddress.argtypes = [C.c_char_p]
        addr = egl.eglGetProcAddress(b'eglGetPlatformDisplayEXT')
        if not addr:
            raise RuntimeError('EGL_EXT_platform_base not available')
        get_platform_display = C.CFUNCTYPE(C.c_void_p, C.c_uint, C.c_void_p, C.c_void_p)(addr)
        self.dpy = get_platform_display(EGL_PLATFORM_SURFACELESS_MESA, None, None)
        egl.eglInitialize.argtypes = [C.c_void_p, C.c_void_p, C.c_void_p]
        if not self.dpy or not egl.eglInitialize(self.dpy, None, None):
            raise RuntimeError('eglInitialize failed (no surfaceless EGL platform?)')
        egl.eglBindAPI.argtypes = [C.c_uint]
        egl.eglBindAPI(EGL_OPENGL_API)
        attrs = (C.c_int * 7)(EGL_CONTEXT_MAJOR_VERSION, 4, EGL_CONTEXT_MINOR_VERSION, 3,
                              EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT,
                              EGL_NONE)
        egl.eglCreateContext.restype = C.c_void_p
        egl.eglCreateContext.argtypes = [C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p]
        self.ctx = egl.eglCreateContext(self.dpy, None, None, attrs)
        if not self.ctx:
            raise RuntimeError('eglCreateContext failed')
        egl.eglMakeCurrent.argtypes = [C.c_void_p] * 4
        if not egl.eglMakeCurrent(self.dpy, None, None, self.ctx):
            raise RuntimeError('eglMakeCurrent failed')
