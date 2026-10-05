export type TraceFlowExample = {
  name: string;
  category: string;
  source: string;
  input: string;
};

export const examples: TraceFlowExample[] = [
  {
    name: "Bubble sort",
    category: "Sorting",
    input: "",
    source: `#include <iostream>
#include <vector>
using namespace std;

int main() {
  vector<int> values = {5, 2, 4, 1, 3};
  int n = values.size();
  for (int i = 0; i < n; i++) {
    for (int j = 0; j < n - i - 1; j++) {
      if (values[j] > values[j + 1]) {
        swap(values[j], values[j + 1]);
      }
    }
  }
  for (int value : values) cout << value << " ";
  cout << endl;
  return 0;
}`,
  },
  {
    name: "Selection sort",
    category: "Sorting",
    input: "",
    source: `#include <iostream>
#include <vector>
using namespace std;

int main() {
  vector<int> values = {29, 10, 14, 37, 13};
  int n = values.size();
  for (int i = 0; i < n - 1; i++) {
    int smallest = i;
    for (int j = i + 1; j < n; j++) {
      if (values[j] < values[smallest]) smallest = j;
    }
    swap(values[i], values[smallest]);
  }
  for (int value : values) cout << value << " ";
  cout << endl;
  return 0;
}`,
  },
  {
    name: "Binary search",
    category: "Searching",
    input: "7",
    source: `#include <iostream>
#include <vector>
using namespace std;

int main() {
  vector<int> values = {2, 4, 7, 9, 12, 15, 18};
  int target;
  cin >> target;
  int left = 0;
  int right = values.size() - 1;
  while (left <= right) {
    int mid = left + (right - left) / 2;
    if (values[mid] == target) {
      cout << mid << endl;
      return mid;
    } else if (values[mid] < target) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  cout << -1 << endl;
  return -1;
}`,
  },
  {
    name: "Fibonacci (recursion)",
    category: "Recursion",
    input: "10",
    source: `#include <iostream>
using namespace std;

int fibonacci(int n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

int main() {
  int n;
  cin >> n;
  int result = fibonacci(n);
  cout << result << endl;
  return result;
}`,
  },
  {
    name: "Factorial",
    category: "Recursion",
    input: "6",
    source: `#include <iostream>
using namespace std;

int factorial(int n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

int main() {
  int n;
  cin >> n;
  int result = factorial(n);
  cout << result << endl;
  return result;
}`,
  },
  {
    name: "GCD",
    category: "Number theory",
    input: "48 18",
    source: `#include <iostream>
using namespace std;

int main() {
  int a;
  int b;
  cin >> a >> b;
  while (b != 0) {
    int remainder = a % b;
    a = b;
    b = remainder;
  }
  cout << a << endl;
  return a;
}`,
  },
  {
    name: "Prime check",
    category: "Number theory",
    input: "29",
    source: `#include <iostream>
using namespace std;

int main() {
  int n;
  cin >> n;
  bool prime = n > 1;
  for (int divisor = 2; divisor * divisor <= n && prime; divisor++) {
    if (n % divisor == 0) prime = false;
  }
  if (prime) cout << "prime" << endl;
  else cout << "not prime" << endl;
  return prime;
}`,
  },
  {
    name: "Reverse an array",
    category: "Arrays",
    input: "",
    source: `#include <iostream>
#include <vector>
using namespace std;

int main() {
  vector<int> values = {3, 8, 1, 6, 4};
  int left = 0;
  int right = values.size() - 1;
  while (left < right) {
    swap(values[left], values[right]);
    left++;
    right--;
  }
  for (int value : values) cout << value << " ";
  cout << endl;
  return 0;
}`,
  },
];