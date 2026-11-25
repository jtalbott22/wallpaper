"""Minimal OpenGL 4.3 core bindings via ctypes (no PyOpenGL / numpy needed).

Functions are resolved lazily through eglGetProcAddress, which works for the
EGL contexts that both GTK4 (on Wayland) and our headless renderer create.
"""
import ctypes as C
import ctypes.util

# ---- constants ---------------------------------------------------------------
FALSE, TRUE = 0, 1
NO_ERROR = 0
VENDOR, RENDERER, VERSION = 0x1F00, 0x1F01, 0x1F02
VIEWPORT = 0x0BA2
FRAMEBUFFER_BINDING = 0x8CA6
DRAW_FRAMEBUFFER_BINDING = 0x8CA6
COLOR_BUFFER_BIT = 0x4000
BLEND = 0x0BE2
DEPTH_TEST = 0x0B71
SCISSOR_TEST = 0x0C11
PROGRAM_POINT_SIZE = 0x8642
ZERO, ONE = 0, 1
SRC_ALPHA, ONE_MINUS_SRC_ALPHA = 0x0302, 0x0303
CONSTANT_ALPHA, ONE_MINUS_CONSTANT_ALPHA = 0x8003, 0x8004
FUNC_ADD, MAX = 0x8006, 0x8008
POINTS, LINES, TRIANGLES, TRIANGLE_STRIP = 0x0000, 0x0001, 0x0004, 0x0005

VERTEX_SHADER, FRAGMENT_SHADER, COMPUTE_SHADER = 0x8B31, 0x8B30, 0x91B9
COMPILE_STATUS, LINK_STATUS, INFO_LOG_LENGTH = 0x8B81, 0x8B82, 0x8B84

TEXTURE_2D = 0x0DE1
TEXTURE0 = 0x84C0
TEXTURE_MIN_FILTER, TEXTURE_MAG_FILTER = 0x2801, 0x2800
TEXTURE_WRAP_S, TEXTURE_WRAP_T = 0x2802, 0x2803
NEAREST, LINEAR = 0x2600, 0x2601
LINEAR_MIPMAP_LINEAR = 0x2703
CLAMP_TO_EDGE, REPEAT, MIRRORED_REPEAT = 0x812F, 0x2901, 0x8370
RGBA, RGB, RG, RED, RED_INTEGER = 0x1908, 0x1907, 0x8227, 0x1903, 0x8D94
RGBA8, RGBA16F, RGBA32F, RG16F, RG32F, R16F, R32F, R32UI = (
    0x8058, 0x881A, 0x8814, 0x822F, 0x8230, 0x822D, 0x822E, 0x8236)
UNSIGNED_BYTE, FLOAT, HALF_FLOAT, UNSIGNED_INT = 0x1401, 0x1406, 0x140B, 0x1405
PACK_ALIGNMENT, UNPACK_ALIGNMENT = 0x0D05, 0x0CF5

FRAMEBUFFER, READ_FRAMEBUFFER, DRAW_FRAMEBUFFER = 0x8D40, 0x8CA8, 0x8CA9
COLOR_ATTACHMENT0 = 0x8CE0
FRAMEBUFFER_COMPLETE = 0x8CD5

ARRAY_BUFFER = 0x8892
SHADER_STORAGE_BUFFER = 0x90D2
DYNAMIC_DRAW, STATIC_DRAW, DYNAMIC_COPY = 0x88E8, 0x88E4, 0x88EA

READ_ONLY, WRITE_ONLY, READ_WRITE = 0x88B8, 0x88B9, 0x88BA
SHADER_IMAGE_ACCESS_BARRIER_BIT = 0x20
SHADER_STORAGE_BARRIER_BIT = 0x2000
TEXTURE_FETCH_BARRIER_BIT = 0x08
VERTEX_ATTRIB_ARRAY_BARRIER_BIT = 0x01
FRAMEBUFFER_BARRIER_BIT = 0x400
ALL_BARRIER_BITS = 0xFFFFFFFF

TIME_ELAPSED = 0x88BF
QUERY_RESULT, QUERY_RESULT_AVAILABLE = 0x8866, 0x8867

# ---- function loading ------------------------------------------------------------
_u, _i, _f, _p = C.c_uint, C.c_int, C.c_float, C.c_void_p
_SPECS = {
    'glGetString': (C.c_char_p, [_u]),
    'glGetIntegerv': (None, [_u, _p]),
    'glGetError': (_u, []),
    'glViewport': (None, [_i, _i, _i, _i]),
    'glClearColor': (None, [_f, _f, _f, _f]),
    'glClear': (None, [_u]),
    'glEnable': (None, [_u]),
    'glDisable': (None, [_u]),
    'glBlendFunc': (None, [_u, _u]),
    'glBlendFuncSeparate': (None, [_u, _u, _u, _u]),
    'glBlendEquation': (None, [_u]),
    'glBlendColor': (None, [_f, _f, _f, _f]),
    'glFinish': (None, []),
    'glFlush': (None, []),
    'glPixelStorei': (None, [_u, _i]),
    'glCreateShader': (_u, [_u]),
    'glShaderSource': (None, [_u, _i, _p, _p]),
    'glCompileShader': (None, [_u]),
    'glGetShaderiv': (None, [_u, _u, _p]),
    'glGetShaderInfoLog': (None, [_u, _i, _p, C.c_char_p]),
    'glDeleteShader': (None, [_u]),
    'glCreateProgram': (_u, []),
    'glAttachShader': (None, [_u, _u]),
    'glLinkProgram': (None, [_u]),
    'glGetProgramiv': (None, [_u, _u, _p]),
    'glGetProgramInfoLog': (None, [_u, _i, _p, C.c_char_p]),
    'glUseProgram': (None, [_u]),
    'glDeleteProgram': (None, [_u]),
    'glGetUniformLocation': (_i, [_u, C.c_char_p]),
    'glUniform1i': (None, [_i, _i]),
    'glUniform1ui': (None, [_i, _u]),
    'glUniform2i': (None, [_i, _i, _i]),
    'glUniform1f': (None, [_i, _f]),
    'glUniform2f': (None, [_i, _f, _f]),
    'glUniform3f': (None, [_i, _f, _f, _f]),
    'glUniform4f': (None, [_i, _f, _f, _f, _f]),
    'glUniform1fv': (None, [_i, _i, _p]),
    'glUniform4fv': (None, [_i, _i, _p]),
    'glUniformMatrix3fv': (None, [_i, _i, C.c_ubyte, _p]),
    'glUniformMatrix4fv': (None, [_i, _i, C.c_ubyte, _p]),
    'glGenTextures': (None, [_i, _p]),
    'glDeleteTextures': (None, [_i, _p]),
    'glBindTexture': (None, [_u, _u]),
    'glActiveTexture': (None, [_u]),
    'glTexImage2D': (None, [_u, _i, _i, _i, _i, _i, _u, _u, _p]),
    'glTexSubImage2D': (None, [_u, _i, _i, _i, _i, _i, _u, _u, _p]),
    'glTexParameteri': (None, [_u, _u, _i]),
    'glGenerateMipmap': (None, [_u]),
    'glGetTexImage': (None, [_u, _i, _u, _u, _p]),
    'glClearTexImage': (None, [_u, _i, _u, _u, _p]),
    'glBindImageTexture': (None, [_u, _u, _i, C.c_ubyte, _i, _u, _u]),
    'glGenFramebuffers': (None, [_i, _p]),
    'glDeleteFramebuffers': (None, [_i, _p]),
    'glBindFramebuffer': (None, [_u, _u]),
    'glFramebufferTexture2D': (None, [_u, _u, _u, _u, _i]),
    'glCheckFramebufferStatus': (_u, [_u]),
    'glBlitFramebuffer': (None, [_i, _i, _i, _i, _i, _i, _i, _i, _u, _u]),
    'glReadPixels': (None, [_i, _i, _i, _i, _u, _u, _p]),
    'glGenBuffers': (None, [_i, _p]),
    'glDeleteBuffers': (None, [_i, _p]),
    'glBindBuffer': (None, [_u, _u]),
    'glBufferData': (None, [_u, C.c_ssize_t, _p, _u]),
    'glBufferSubData': (None, [_u, C.c_ssize_t, C.c_ssize_t, _p]),
    'glGetBufferSubData': (None, [_u, C.c_ssize_t, C.c_ssize_t, _p]),
    'glBindBufferBase': (None, [_u, _u, _u]),
    'glGenVertexArrays': (None, [_i, _p]),
    'glDeleteVertexArrays': (None, [_i, _p]),
    'glBindVertexArray': (None, [_u]),
    'glDrawArrays': (None, [_u, _i, _i]),
    'glDispatchCompute': (None, [_u, _u, _u]),
    'glMemoryBarrier': (None, [_u]),
    'glGenQueries': (None, [_i, _p]),
    'glDeleteQueries': (None, [_i, _p]),
    'glBeginQuery': (None, [_u, _u]),
    'glEndQuery': (None, [_u]),
    'glGetQueryObjectiv': (None, [_u, _u, _p]),
    'glGetQueryObjectui64v': (None, [_u, _u, _p]),
}

_loader = None


def _get_loader():
    global _loader
    if _loader is None:
        egl = C.CDLL(ctypes.util.find_library('EGL') or 'libEGL.so.1')
        egl.eglGetProcAddress.restype = C.c_void_p
        egl.eglGetProcAddress.argtypes = [C.c_char_p]
        _loader = egl.eglGetProcAddress
    return _loader


class _GL:
    def __getattr__(self, name):
        full = 'gl' + name
        if full not in _SPECS:
            raise AttributeError(name)
        addr = _get_loader()(full.encode())
        if not addr:
            raise RuntimeError(f'OpenGL function {full} not available')
        res, args = _SPECS[full]
        fn = C.CFUNCTYPE(res, *args)(addr)
        setattr(self, name, fn)
        return fn


gl = _GL()


# ---- helpers -----------------------------------------------------------------------
def get_int(pname, n=1):
    buf = (C.c_int * max(4, n))()
    gl.GetIntegerv(pname, buf)
    return buf[0] if n == 1 else list(buf[:n])


def check(where=''):
    err = gl.GetError()
    if err != NO_ERROR:
        raise RuntimeError(f'GL error 0x{err:04x} {where}')


def _gen(fn, n=1):
    buf = (C.c_uint * n)()
    fn(n, buf)
    return buf[0]


class ShaderError(RuntimeError):
    pass


def _compile(kind, src, label):
    sh = gl.CreateShader(kind)
    b = src.encode()
    arr = (C.c_char_p * 1)(b)
    gl.ShaderSource(sh, 1, arr, None)
    gl.CompileShader(sh)
    ok = C.c_int()
    gl.GetShaderiv(sh, COMPILE_STATUS, C.byref(ok))
    if not ok.value:
        log = C.create_string_buffer(8192)
        gl.GetShaderInfoLog(sh, 8192, None, log)
        lines = src.split('\n')
        msg = log.value.decode(errors='replace')
        # show offending lines for quick debugging
        ctx = []
        import re
        for m in re.finditer(r'0:(\d+)\(\d+\)', msg):
            ln = int(m.group(1))
            if 0 < ln <= len(lines):
                ctx.append(f'  {ln}: {lines[ln - 1]}')
        raise ShaderError(f'{label}: compile failed\n{msg}\n' + '\n'.join(ctx[:6]))
    return sh


class Program:
    """A linked GL program with a cached, type-dispatching uniform setter."""

    def __init__(self, label, vs=None, fs=None, cs=None):
        self.label = label
        self.id = gl.CreateProgram()
        shaders = []
        if cs is not None:
            shaders.append(_compile(COMPUTE_SHADER, cs, label + '.comp'))
        if vs is not None:
            shaders.append(_compile(VERTEX_SHADER, vs, label + '.vert'))
        if fs is not None:
            shaders.append(_compile(FRAGMENT_SHADER, fs, label + '.frag'))
        for s in shaders:
            gl.AttachShader(self.id, s)
        gl.LinkProgram(self.id)
        ok = C.c_int()
        gl.GetProgramiv(self.id, LINK_STATUS, C.byref(ok))
        for s in shaders:
            gl.DeleteShader(s)
        if not ok.value:
            log = C.create_string_buffer(8192)
            gl.GetProgramInfoLog(self.id, 8192, None, log)
            raise ShaderError(f'{label}: link failed\n{log.value.decode(errors="replace")}')
        self._loc = {}

    def use(self):
        gl.UseProgram(self.id)
        return self

    def loc(self, name):
        l = self._loc.get(name)
        if l is None:
            l = gl.GetUniformLocation(self.id, name.encode())
            self._loc[name] = l
        return l

    def set(self, **kw):
        for k, v in kw.items():
            l = self.loc(k)
            if l < 0:
                continue
            if isinstance(v, bool):
                gl.Uniform1i(l, int(v))
            elif isinstance(v, int):
                gl.Uniform1i(l, v)
            elif isinstance(v, float):
                gl.Uniform1f(l, v)
            elif isinstance(v, (tuple, list)):
                n = len(v)
                if n == 2:
                    gl.Uniform2f(l, *map(float, v))
                elif n == 3:
                    gl.Uniform3f(l, *map(float, v))
                elif n == 4:
                    gl.Uniform4f(l, *map(float, v))
                elif n == 9:
                    gl.UniformMatrix3fv(l, 1, 0, (C.c_float * 9)(*v))
                elif n == 16:
                    gl.UniformMatrix4fv(l, 1, 0, (C.c_float * 16)(*v))
                else:
                    raise ValueError(f'uniform {k}: unsupported length {n}')
            else:
                raise TypeError(f'uniform {k}: {type(v)}')
        return self

    def set_ivec2(self, name, x, y):
        l = self.loc(name)
        if l >= 0:
            gl.Uniform2i(l, int(x), int(y))
        return self

    def set_uint(self, name, v):
        l = self.loc(name)
        if l >= 0:
            gl.Uniform1ui(l, int(v) & 0xFFFFFFFF)
        return self

    def set_vec4_array(self, name, values):
        l = self.loc(name)
        if l >= 0 and values:
            flat = [float(x) for v in values for x in v]
            gl.Uniform4fv(l, len(values), (C.c_float * len(flat))(*flat))
        return self

    def dispatch(self, nx, ny=1, nz=1):
        gl.DispatchCompute(max(1, int(nx)), max(1, int(ny)), max(1, int(nz)))

    def delete(self):
        if self.id:
            gl.DeleteProgram(self.id)
            self.id = 0


_FMT = {
    RGBA16F: (RGBA, HALF_FLOAT),
    RGBA32F: (RGBA, FLOAT),
    RGBA8: (RGBA, UNSIGNED_BYTE),
    RG16F: (RG, HALF_FLOAT),
    RG32F: (RG, FLOAT),
    R16F: (RED, HALF_FLOAT),
    R32F: (RED, FLOAT),
    R32UI: (RED_INTEGER, UNSIGNED_INT),
}


class Texture:
    def __init__(self, w, h, ifmt=RGBA16F, filter=LINEAR, wrap=CLAMP_TO_EDGE, data=None):
        self.w, self.h, self.ifmt = int(w), int(h), ifmt
        self.id = _gen(gl.GenTextures)
        fmt, typ = _FMT[ifmt]
        self.fmt, self.typ = fmt, typ
        gl.BindTexture(TEXTURE_2D, self.id)
        gl.TexImage2D(TEXTURE_2D, 0, ifmt, self.w, self.h, 0, fmt, typ, data)
        if ifmt == R32UI:
            filter = NEAREST
        gl.TexParameteri(TEXTURE_2D, TEXTURE_MIN_FILTER, filter)
        gl.TexParameteri(TEXTURE_2D, TEXTURE_MAG_FILTER, filter)
        gl.TexParameteri(TEXTURE_2D, TEXTURE_WRAP_S, wrap)
        gl.TexParameteri(TEXTURE_2D, TEXTURE_WRAP_T, wrap)
        self.clear()

    def bind(self, unit=0):
        gl.ActiveTexture(TEXTURE0 + unit)
        gl.BindTexture(TEXTURE_2D, self.id)
        return self

    def bind_image(self, unit, access=READ_WRITE):
        gl.BindImageTexture(unit, self.id, 0, 0, 0, access, self.ifmt)
        return self

    def clear(self):
        gl.ClearTexImage(self.id, 0, self.fmt, self.typ, None)

    def upload_floats(self, values):
        """values: flat list of floats (RGBA32F/RGBA16F with w*h*4 entries)."""
        arr = (C.c_float * len(values))(*values)
        gl.BindTexture(TEXTURE_2D, self.id)
        gl.TexSubImage2D(TEXTURE_2D, 0, 0, 0, self.w, self.h, self.fmt, FLOAT, arr)

    def delete(self):
        if self.id:
            gl.DeleteTextures(1, (C.c_uint * 1)(self.id))
            self.id = 0


class Framebuffer:
    def __init__(self, tex):
        self.tex = tex
        self.id = _gen(gl.GenFramebuffers)
        gl.BindFramebuffer(FRAMEBUFFER, self.id)
        gl.FramebufferTexture2D(FRAMEBUFFER, COLOR_ATTACHMENT0, TEXTURE_2D, tex.id, 0)
        st = gl.CheckFramebufferStatus(FRAMEBUFFER)
        if st != FRAMEBUFFER_COMPLETE:
            raise RuntimeError(f'framebuffer incomplete 0x{st:x}')

    @property
    def w(self):
        return self.tex.w

    @property
    def h(self):
        return self.tex.h

    def bind(self):
        gl.BindFramebuffer(FRAMEBUFFER, self.id)
        gl.Viewport(0, 0, self.tex.w, self.tex.h)
        return self

    def delete(self):
        if self.id:
            gl.DeleteFramebuffers(1, (C.c_uint * 1)(self.id))
            self.id = 0


class RenderTarget:
    """Texture + framebuffer pair."""

    def __init__(self, w, h, ifmt=RGBA16F, filter=LINEAR, wrap=CLAMP_TO_EDGE):
        self.tex = Texture(w, h, ifmt, filter, wrap)
        self.fbo = Framebuffer(self.tex)
        self.w, self.h = self.tex.w, self.tex.h

    def bind(self):
        return self.fbo.bind()

    def delete(self):
        self.fbo.delete()
        self.tex.delete()


class PingPong:
    def __init__(self, w, h, ifmt=RGBA16F, filter=LINEAR, wrap=CLAMP_TO_EDGE):
        self.a = RenderTarget(w, h, ifmt, filter, wrap)
        self.b = RenderTarget(w, h, ifmt, filter, wrap)
        self.w, self.h = w, h

    @property
    def src(self):
        return self.a

    @property
    def dst(self):
        return self.b

    def swap(self):
        self.a, self.b = self.b, self.a

    def delete(self):
        self.a.delete()
        self.b.delete()


class Buffer:
    def __init__(self, nbytes, data=None, usage=DYNAMIC_COPY):
        self.id = _gen(gl.GenBuffers)
        self.nbytes = int(nbytes)
        gl.BindBuffer(SHADER_STORAGE_BUFFER, self.id)
        gl.BufferData(SHADER_STORAGE_BUFFER, self.nbytes, data, usage)

    def bind_base(self, index):
        gl.BindBufferBase(SHADER_STORAGE_BUFFER, index, self.id)
        return self

    def write(self, data_bytes, offset=0):
        gl.BindBuffer(SHADER_STORAGE_BUFFER, self.id)
        gl.BufferSubData(SHADER_STORAGE_BUFFER, offset, len(data_bytes), data_bytes)

    def read(self, nbytes, offset=0):
        buf = C.create_string_buffer(nbytes)
        gl.BindBuffer(SHADER_STORAGE_BUFFER, self.id)
        gl.GetBufferSubData(SHADER_STORAGE_BUFFER, offset, nbytes, buf)
        return buf.raw

    def delete(self):
        if self.id:
            gl.DeleteBuffers(1, (C.c_uint * 1)(self.id))
            self.id = 0


class EmptyVAO:
    """Core profile needs a VAO bound for any draw, even attribute-less ones."""

    def __init__(self):
        self.id = _gen(gl.GenVertexArrays)

    def bind(self):
        gl.BindVertexArray(self.id)


def barrier(bits=ALL_BARRIER_BITS):
    gl.MemoryBarrier(bits)


class GpuTimer:
    """Non-blocking GPU frame timer using a small ring of TIME_ELAPSED queries."""

    def __init__(self, n=4):
        buf = (C.c_uint * n)()
        gl.GenQueries(n, buf)
        self.ids = list(buf)
        self.n = n
        self.i = 0
        self.pending = [False] * n
        self.last_ms = None

    def begin(self):
        q = self.ids[self.i]
        if self.pending[self.i]:
            self._collect(self.i)
        gl.BeginQuery(TIME_ELAPSED, q)

    def end(self):
        gl.EndQuery(TIME_ELAPSED)
        self.pending[self.i] = True
        self.i = (self.i + 1) % self.n
        # opportunistically collect the oldest finished query
        j = self.i
        if self.pending[j]:
            avail = C.c_int()
            gl.GetQueryObjectiv(self.ids[j], QUERY_RESULT_AVAILABLE, C.byref(avail))
            if avail.value:
                self._collect(j)

    def _collect(self, j):
        ns = C.c_uint64()
        gl.GetQueryObjectui64v(self.ids[j], QUERY_RESULT, C.byref(ns))
        self.pending[j] = False
        self.last_ms = ns.value / 1e6
