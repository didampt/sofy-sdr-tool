# Sert public/ en local AVEC les en-têtes de sécurité de vercel.json.
#
# Pourquoi ce fichier existe : le 20/08/2026, le compresseur d'image passait par une URL blob:.
# La CSP de production autorise « img-src 'self' data: https: » — donc PAS blob: — et toutes les
# images étaient refusées (« Image illisible ») chez l'utilisateur. En local, servi par un
# http.server nu, tout fonctionnait : les en-têtes de Vercel n'y étaient pas.
#
#   python3 outils/serveur-test-csp.py   →   http://localhost:8902
#
# À utiliser pour tout test front qui touche aux images, aux médias ou aux appels réseau.
import http.server, functools, json, os
CSP = json.load(open('/Users/didierampiot/Desktop/github/sofy-sdr-tool/vercel.json'))
csp = next(k['value'] for h in CSP['headers'] for k in h['headers'] if k['key']=='Content-Security-Policy')
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Content-Security-Policy', csp)
        super().end_headers()
if __name__=='__main__':
    os.chdir('/Users/didierampiot/Desktop/github/sofy-sdr-tool/public')
    http.server.HTTPServer(('127.0.0.1',8902), H).serve_forever()
