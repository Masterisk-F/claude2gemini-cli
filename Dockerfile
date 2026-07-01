FROM archlinux:base-devel

WORKDIR /app

# Install Node.js, npm, git, sqlite (for reading auth status)
RUN pacman -Syu --noconfirm nodejs npm git sqlite

# Create a non-root user for makepkg
RUN useradd -m -G wheel builder && \
    echo "builder ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Install Antigravity from AUR
USER builder
RUN cd /tmp && \
    git clone https://aur.archlinux.org/antigravity.git && \
    cd antigravity && \
    makepkg -si --noconfirm && \
    cd / && rm -rf /tmp/antigravity

# Switch back to root
USER root

# Copy package files and local libraries
COPY antigravity-client ./antigravity-client
COPY package*.json ./

# Install dependencies and explicitly build the local library
RUN npm install && cd antigravity-client && npm install && npm run build

# Copy source code
COPY . .

# Expose proxy port
EXPOSE 8080

# Environment variables
ENV NO_BROWSER=true
ENV ANTIGRAVITY_LS_BINARY=/usr/bin/antigravity

CMD ["npm", "run", "dev"]
