FROM nginx:1.27-alpine

# Remove the default site and install the EcoWing config
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY index.html config.js /usr/share/nginx/html/

ENV BACKEND_HOST=backend BACKEND_PORT=3000

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/index.html >/dev/null || exit 1
