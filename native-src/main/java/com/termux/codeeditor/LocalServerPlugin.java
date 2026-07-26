package com.termux.codeeditor;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;

import fi.iki.elonen.NanoHTTPD;

/**
 * A small embedded static-file HTTP server, bound to 127.0.0.1, that serves
 * whatever project folder the editor currently has open as its root — so
 * the app can produce a real "http://127.0.0.1:PORT" URL for a project
 * without needing Termux or any other external server running.
 */
@CapacitorPlugin(name = "LocalServer")
public class LocalServerPlugin extends Plugin {

    private StaticFileServer server;

    static class StaticFileServer extends NanoHTTPD {
        private final File rootDir;

        StaticFileServer(int port, String rootPath) throws IOException {
            super("127.0.0.1", port);
            this.rootDir = new File(rootPath);
            start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
        }

        @Override
        public Response serve(IHTTPSession session) {
            String uri = session.getUri();
            if (uri == null || uri.isEmpty() || uri.equals("/")) uri = "/index.html";

            try {
                File requested = new File(rootDir, uri);
                String rootCanonical = rootDir.getCanonicalPath();
                String requestedCanonical = requested.getCanonicalPath();

                // Refuse anything that resolves outside the served root.
                if (!requestedCanonical.equals(rootCanonical)
                        && !requestedCanonical.startsWith(rootCanonical + File.separator)) {
                    return newFixedLengthResponse(Response.Status.FORBIDDEN, "text/plain", "Forbidden");
                }

                if (!requested.exists() || requested.isDirectory()) {
                    return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found: " + uri);
                }

                Response res = newFixedLengthResponse(Response.Status.OK, guessMime(requested.getName()),
                        new FileInputStream(requested), requested.length());
                res.addHeader("Cache-Control", "no-cache");
                return res;
            } catch (IOException e) {
                return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain", "Error: " + e.getMessage());
            }
        }

        private String guessMime(String name) {
            String n = name.toLowerCase();
            if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
            if (n.endsWith(".css")) return "text/css";
            if (n.endsWith(".js") || n.endsWith(".mjs")) return "application/javascript";
            if (n.endsWith(".json")) return "application/json";
            if (n.endsWith(".png")) return "image/png";
            if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
            if (n.endsWith(".gif")) return "image/gif";
            if (n.endsWith(".svg")) return "image/svg+xml";
            if (n.endsWith(".webp")) return "image/webp";
            if (n.endsWith(".ico")) return "image/x-icon";
            if (n.endsWith(".woff")) return "font/woff";
            if (n.endsWith(".woff2")) return "font/woff2";
            if (n.endsWith(".txt")) return "text/plain";
            if (n.endsWith(".xml")) return "application/xml";
            return "application/octet-stream";
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        String root = call.getString("root");
        int port = call.getInt("port", 8091);
        if (root == null || root.isEmpty()) { call.reject("root is required"); return; }

        try {
            if (server != null) {
                server.stop();
                server = null;
            }
            server = new StaticFileServer(port, root);
            JSObject ret = new JSObject();
            ret.put("url", "http://127.0.0.1:" + port);
            ret.put("root", root);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not start server: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (server != null) {
            server.stop();
            server = null;
        }
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", server != null && server.isAlive());
        call.resolve(ret);
    }
}
