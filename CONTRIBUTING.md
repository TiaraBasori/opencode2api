# Contributing to opencode2api

Thank you for your interest in contributing to opencode2api!

## Code of Conduct

Please be respectful and professional. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

## How to Contribute

### Reporting Bugs

1. Check if the issue already exists
2. Create a detailed issue with:
   - Clear title and description
   - Steps to reproduce
   - Environment details
   - Relevant logs

### Suggesting Features

1. Open an issue with `[Feature Request]` prefix
2. Describe the use case
3. Propose a solution or API design

### Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run tests: `npm test`
5. Commit with clear messages (see Commit Style below)
6. Push to your fork
7. Submit a Pull Request

## Commit Style

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Code style (formatting)
- `refactor`: Code refactoring
- `test`: Tests
- `chore`: Build/ci updates

Examples:
```
feat(api): add streaming support for Responses API
fix(proxy): resolve memory leak in long-running sessions
docs: update configuration documentation
```

## Development Setup

```bash
# Clone and install
git clone https://github.com/TiaraBasori/opencode2api.git
cd opencode2api
npm install

# Run tests
npm test

# Start locally
npm start
```

## Testing

- Unit tests: `npm run test:unit`
- Integration tests: `npm run test:integration`
- All tests: `npm test -- --runInBand`

## Code Review Process

1. All submissions require review
2. Address feedback promptly
3. Squash commits before merge

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE.md).